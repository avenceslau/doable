/**
 * Result Serialization Bridge — caller + callee codec
 *
 * Callee side: wraps method return values in an envelope
 *   `{ ok: true, value }` or `{ ok: false, error }`.
 * Caller side: unwraps the envelope and re-throws if error.
 *
 * This mirrors the PRD's `betterResultBridge` pattern — a codec that
 * serializes structured results across the RPC boundary.
 */
import { createTransform } from "../../src";

export type ResultEnvelope<T = unknown> =
	| { ok: true; value: T }
	| { ok: false; error: string; code?: string };

/**
 * Callee-side: wraps return values into ResultEnvelope.
 */
export function createResultCalleeCodec<TInstance extends object>() {
	return createTransform<TInstance>().callee(() => async ({ next }) => {
		try {
			const value = await next();
			return { ok: true, value } satisfies ResultEnvelope;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error instanceof Error && "code" in error
					? String((error as Error & { code: string }).code)
					: undefined;
			return { ok: false, error: message, code } satisfies ResultEnvelope;
		}
	})();
}

/**
 * Caller-side: unwraps ResultEnvelope back to values/errors.
 */
export function createResultCallerCodec<TStub extends object>() {
	return createTransform<TStub>().caller(() => async ({ next }) => {
		const envelope = (await next()) as ResultEnvelope;

		// If the result doesn't look like an envelope, pass through
		if (
			typeof envelope !== "object" ||
			envelope === null ||
			!("ok" in envelope)
		) {
			return envelope;
		}

		if (envelope.ok) {
			return envelope.value;
		}

		const error = new Error(envelope.error);
		if (envelope.code !== undefined) {
			(error as Error & { code?: string }).code = envelope.code;
		}

		throw error;
	})();
}

/**
 * Full bridge: both sides defined together via .caller().callee()
 * for codebases that want a single import.
 */
export function createResultBridge<TStub extends object>() {
	const callerCalleeFactory = createTransform<TStub>()
		.caller(() => async ({ next }) => {
			const envelope = (await next()) as ResultEnvelope;
			if (
				typeof envelope !== "object" ||
				envelope === null ||
				!("ok" in envelope)
			) {
				return envelope;
			}

			if (envelope.ok) {
				return envelope.value;
			}

			const error = new Error(envelope.error);
			if (envelope.code !== undefined) {
				(error as Error & { code?: string }).code = envelope.code;
			}

			throw error;
		})
		.callee(() => async ({ next }) => {
			try {
				const value = await next();
				return { ok: true, value } satisfies ResultEnvelope;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code =
					error instanceof Error && "code" in error
						? String((error as Error & { code: string }).code)
						: undefined;
				return {
					ok: false,
					error: message,
					code,
				} satisfies ResultEnvelope;
			}
		});

	// callerCalleeFactory is: () => ((...calleeArgs) => CalleeTransform) & CallerTransform
	const combined = callerCalleeFactory();
	const calleeTransform = combined();
	return { onCall: combined.onCall, onReceive: calleeTransform.onReceive };
}
