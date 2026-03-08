/**
 * Observability Transform — caller + callee
 *
 * Caller side: records wall-clock timing of the RPC call.
 * Callee side: records CPU-time of method execution.
 *
 * Demonstrates the paired caller/callee pattern from the PRD's
 * observability context-injection example.
 */
import { createTransform } from "../../src";

export type MetricEntry = {
	label: string;
	method: string;
	durationMs: number;
	id?: unknown;
};

export type ObservabilityCallerOptions = {
	emitMetric: (entry: MetricEntry) => void;
};

/**
 * Caller-side: wraps stub calls with wall-clock timing.
 */
export function createObservabilityCaller<TStub extends object>(
	options: ObservabilityCallerOptions
) {
	const { emitMetric } = options;

	return createTransform<TStub>().caller(() => async ({ method, id, next }) => {
		const start = performance.now();
		try {
			const result = await next();
			emitMetric({
				label: "rpc_ok",
				method,
				id,
				durationMs: performance.now() - start,
			});
			return result;
		} catch (error) {
			emitMetric({
				label: "rpc_error",
				method,
				id,
				durationMs: performance.now() - start,
			});
			throw error;
		}
	})();
}

/**
 * Callee-side: wraps method execution with CPU-time timing.
 */
export function createObservabilityCallee<TInstance extends object>(
	emitMetric: (entry: MetricEntry) => void
) {
	return createTransform<TInstance>().callee(() => async ({ method, next }) => {
		const start = performance.now();
		try {
			const result = await next();
			emitMetric({
				label: "method_ok",
				method,
				durationMs: performance.now() - start,
			});
			return result;
		} catch (error) {
			emitMetric({
				label: "method_error",
				method,
				durationMs: performance.now() - start,
			});
			throw error;
		}
	})();
}

/**
 * Full observability transform — both sides in one definition.
 * Demonstrates .caller().callee() chaining with always-factory API.
 */
export function createFullObservability<TStub extends object>() {
	const callerCalleeFactory = createTransform<
		TStub,
		{},
		{ accountId: number }
	>()
		.caller(() => async ({ method, id, next, context }) => {
			const start = performance.now();
			const result = await next();
			const elapsed = performance.now() - start;
			(result as Record<string, unknown>).__callerMs = elapsed;
			(result as Record<string, unknown>).__callerMethod = method;
			(result as Record<string, unknown>).__callerId = id;
			context.accountId = 0;
			return result;
		})
		.callee(() => async ({ method, next }) => {
			const start = performance.now();
			const result = await next();
			const elapsed = performance.now() - start;
			(result as Record<string, unknown>).__calleeMs = elapsed;
			(result as Record<string, unknown>).__calleeMethod = method;
			return result;
		});

	// callerCalleeFactory is: () => ((...calleeArgs) => CalleeTransform) & CallerTransform
	// Call it with zero args to get the combined transform
	const combined = callerCalleeFactory();
	// combined is: (() => CalleeTransform) & CallerTransform
	// The callee part needs to be called too
	const calleeTransform = combined();
	// Merge: combined has .onCall, calleeTransform has .onReceive
	return { onCall: combined.onCall, onReceive: calleeTransform.onReceive };
}

// ---------------------------------------------------------------------------
// context-based observability (PRD pattern)
// ---------------------------------------------------------------------------

export type ContextMetricEntry = MetricEntry & {
	accountId?: string;
	coloId?: string;
};

export type ObservabilityContextOptions = {
	accountId: string;
	coloId: string;
	emitMetric: (entry: ContextMetricEntry) => void;
};

/**
 * PRD-style observability using context.
 *
 * Caller side: injects accountId/coloId into context,
 *   records wall-clock ("eyeball") timing.
 * Callee side: reads accountId/coloId from context,
 *   records CPU timing.
 */
export function createContextObservabilityCaller<TStub extends object>(
	options: ObservabilityContextOptions
) {
	const { accountId, coloId, emitMetric } = options;

	return createTransform<TStub>().caller(() => async ({ method, id, next }) => {
		const start = performance.now();
		try {
			const result = await next({
				context: { accountId, coloId },
			});
			emitMetric({
				label: "eyeball_ok",
				method,
				id,
				durationMs: performance.now() - start,
				accountId,
				coloId,
			});
			return result;
		} catch (error) {
			emitMetric({
				label: "eyeball_error",
				method,
				id,
				durationMs: performance.now() - start,
				accountId,
				coloId,
			});
			throw error;
		}
	})();
}

export function createContextObservabilityCallee<TInstance extends object>(
	emitMetric: (entry: ContextMetricEntry) => void
) {
	return createTransform<TInstance>().callee(
		() =>
			async ({ method, context, next }) => {
				const accountId = context.accountId as string | undefined;
				const coloId = context.coloId as string | undefined;
				const start = performance.now();
				try {
					const result = await next();
					emitMetric({
						label: "cpu_ok",
						method,
						durationMs: performance.now() - start,
						accountId,
						coloId,
					});
					return result;
				} catch (error) {
					emitMetric({
						label: "cpu_error",
						method,
						durationMs: performance.now() - start,
						accountId,
						coloId,
					});
					throw error;
				}
			}
	)();
}
