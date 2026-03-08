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
/**
 * Callee-side: wraps return values into ResultEnvelope.
 */
export function createResultCalleeCodec() {
    return createTransform().callee(() => async ({ next }) => {
        try {
            const value = await next();
            return { ok: true, value };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof Error && "code" in error
                ? String(error.code)
                : undefined;
            return { ok: false, error: message, code };
        }
    })();
}
/**
 * Caller-side: unwraps ResultEnvelope back to values/errors.
 */
export function createResultCallerCodec() {
    return createTransform().caller(() => async ({ next }) => {
        const envelope = (await next());
        // If the result doesn't look like an envelope, pass through
        if (typeof envelope !== "object" ||
            envelope === null ||
            !("ok" in envelope)) {
            return envelope;
        }
        if (envelope.ok) {
            return envelope.value;
        }
        const error = new Error(envelope.error);
        if (envelope.code !== undefined) {
            error.code = envelope.code;
        }
        throw error;
    })();
}
/**
 * Full bridge: both sides defined together via .caller().callee()
 * for codebases that want a single import.
 */
export function createResultBridge() {
    const callerCalleeFactory = createTransform()
        .caller(() => async ({ next }) => {
        const envelope = (await next());
        if (typeof envelope !== "object" ||
            envelope === null ||
            !("ok" in envelope)) {
            return envelope;
        }
        if (envelope.ok) {
            return envelope.value;
        }
        const error = new Error(envelope.error);
        if (envelope.code !== undefined) {
            error.code = envelope.code;
        }
        throw error;
    })
        .callee(() => async ({ next }) => {
        try {
            const value = await next();
            return { ok: true, value };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof Error && "code" in error
                ? String(error.code)
                : undefined;
            return {
                ok: false,
                error: message,
                code,
            };
        }
    });
    // callerCalleeFactory is: () => ((...calleeArgs) => CalleeTransform) & CallerTransform
    const combined = callerCalleeFactory();
    const calleeTransform = combined();
    return { onCall: combined.onCall, onReceive: calleeTransform.onReceive };
}
