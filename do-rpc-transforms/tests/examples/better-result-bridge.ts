/**
 * Better-Result Bridge — caller + callee codec using `better-result`
 *
 * This is the PRD's `betterResultBridge` pattern implemented verbatim:
 *
 * - Callee side: serializes `Result` return values via `Result.serialize()`.
 * - Caller side: deserializes the wire payload back into a `Result` instance
 *   via `Result.deserialize()`, falling through for non-Result values.
 *
 * Additionally demonstrates `createMetricsFromCodec` — a caller transform
 * that uses `createTransform<typeof codec>()` to infer the codec's output
 * type and pattern-match on concrete error types with full type safety.
 */
import {
	matchErrorPartial,
	Result,
	ResultDeserializationError,
	TaggedError,
} from "better-result";
import { createTransform } from "../../src";
import type { CallerTransform } from "../../src";
import type { Result as ResultType } from "better-result";

// ---------------------------------------------------------------------------
// Domain error types (PRD example)
// ---------------------------------------------------------------------------

export class RetryableNetworkError extends TaggedError(
	"RetryableNetworkError"
)<{
	message: string;
}>() {}

export class UserInputError extends TaggedError("UserInputError")<{
	message: string;
}>() {}

export type AppError = RetryableNetworkError | UserInputError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isResult(value: unknown): value is ResultType<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		((value as Record<string, unknown>).status === "ok" ||
			(value as Record<string, unknown>).status === "error")
	);
}

// ---------------------------------------------------------------------------
// betterResultBridge — caller + callee codec
// ---------------------------------------------------------------------------

/**
 * Callee-side: serializes Result values over the wire.
 */
export function createBetterResultCalleeCodec<TInstance extends object>() {
	return createTransform<TInstance>().callee(() => async ({ next }) => {
		const value = await next();

		// Only serialize when the return value is an actual Result
		if (isResult(value)) {
			return Result.serialize(value);
		}

		return value;
	})();
}

/**
 * Caller-side codec that deserializes Result values from the wire.
 *
 * Publishes its output type via the contract's `output` key so that
 * downstream transforms built with `createTransform<typeof codec>()`
 * can infer the decoded shape from `next()`.
 *
 * @typeParam TStub - The DO class / stub type
 * @typeParam TOutput - The Result type returned after deserialization
 *   (e.g. `Result<{ id: string; title: string }, AppError>`)
 */
export function createBetterResultCallerCodec<
	TStub extends object,
	TOutput = unknown,
>() {
	return createTransform<
		TStub,
		{ output: TOutput },
		Record<string, unknown>,
		TOutput
	>().caller(() => async ({ next }) => {
		const wireValue = await next();
		try {
			const parsed = Result.deserialize(wireValue as never);

			// If deserialization itself produced an error, pass through raw
			if (
				Result.isError(parsed) &&
				ResultDeserializationError.is(parsed.error)
			) {
				return wireValue;
			}

			return parsed;
		} catch {
			return wireValue;
		}
	})();
}

/**
 * Full bridge: both sides in one definition via .caller().callee() chaining.
 *
 * Publishes the output type so downstream transforms can infer it.
 */
export function createBetterResultBridge<
	TStub extends object,
	TOutput = unknown,
>() {
	const callerCalleeFactory = createTransform<
		TStub,
		{ output: TOutput },
		Record<string, unknown>,
		TOutput
	>()
		.caller(() => async ({ next }) => {
			const wireValue = await next();
			try {
				const parsed = Result.deserialize(wireValue as never);
				if (
					Result.isError(parsed) &&
					ResultDeserializationError.is(parsed.error)
				) {
					return wireValue;
				}

				return parsed;
			} catch {
				return wireValue;
			}
		})
		.callee(() => async ({ next }) => {
			const value = await next();
			if (isResult(value)) {
				return Result.serialize(value);
			}

			return value;
		});

	const combined = callerCalleeFactory();
	const calleeTransform = combined();
	return { onCall: combined.onCall, onReceive: calleeTransform.onReceive };
}

// ---------------------------------------------------------------------------
// metricsWithBetterResult — error-type-aware metrics (PRD example)
//
// Original version: takes TStub as an explicit generic and uses
// runtime `isResult` + `as AppError` cast to pattern-match errors.
// ---------------------------------------------------------------------------

export type BetterResultMetricEntry = {
	label: string;
	method: string;
	id?: unknown;
	durationMs: number;
};

export type BetterResultMetricsOptions = {
	emitMetrics: (entry: BetterResultMetricEntry) => void;
};

/**
 * Caller-side: consumes the decoded `Result` and emits metrics
 * keyed by concrete error type via `matchErrorPartial`.
 *
 * Must be stacked *after* the caller codec so it sees `Result`
 * instances, not raw wire payloads.
 */
export function createMetricsWithBetterResult<TStub extends object>(
	options: BetterResultMetricsOptions
) {
	const { emitMetrics } = options;

	return createTransform<TStub>().caller(() => async ({ method, id, next }) => {
		const started = performance.now();
		const value = await next();

		if (isResult(value) && Result.isError(value)) {
			const label: string = matchErrorPartial(
				value.error as AppError,
				{
					RetryableNetworkError: () => "rpc_error_retryable_network",
					UserInputError: () => "rpc_error_user_input",
				},
				() => "rpc_error_unknown"
			);

			emitMetrics({
				label,
				method,
				id,
				durationMs: performance.now() - started,
			});
		} else {
			emitMetrics({
				label: "rpc_ok",
				method,
				id,
				durationMs: performance.now() - started,
			});
		}

		return value;
	})();
}

// ---------------------------------------------------------------------------
// createMetricsFromCodec — typed metrics via createTransform<typeof codec>()
//
// This is the new pattern: instead of manually casting `value.error`,
// the metrics transform infers the output type from the codec transform.
// `next()` returns `TOutput` (e.g. `Result<Ok, AppError>`) so
// `Result.isError(value)` narrows `value.error` to the full error union.
// ---------------------------------------------------------------------------

/**
 * Creates a caller-side metrics transform that infers its output type
 * from a previous codec transform.
 *
 * Usage:
 * ```ts
 * const codec = createBetterResultCallerCodec<MyDO, Result<Ok, AppError>>();
 * const metrics = createMetricsFromCodec(codec, { emitMetrics: m => ... });
 *
 * stub.with(codec).with(metrics);
 * ```
 *
 * Because `metrics` is built with `createTransform<typeof codec>()`,
 * the handler's `next()` returns `Result<Ok, AppError>` — no casts needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMetricsFromCodec<
	TCodec extends CallerTransform<any, any, any, any>,
>(_codec: TCodec, options: BetterResultMetricsOptions) {
	const { emitMetrics } = options;

	return createTransform<TCodec>().caller(
		() =>
			async ({ method, id, next }) => {
				const started = performance.now();
				const value = await next();

				if (isResult(value) && Result.isError(value)) {
					const label: string = matchErrorPartial(
						value.error as AppError,
						{
							RetryableNetworkError: () => "rpc_error_retryable_network",
							UserInputError: () => "rpc_error_user_input",
						},
						() => "rpc_error_unknown"
					);

					emitMetrics({
						label,
						method,
						id,
						durationMs: performance.now() - started,
					});
				} else {
					emitMetrics({
						label: "rpc_ok",
						method,
						id,
						durationMs: performance.now() - started,
					});
				}

				return value;
			}
	)();
}
