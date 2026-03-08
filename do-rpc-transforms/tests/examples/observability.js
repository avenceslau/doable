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
/**
 * Caller-side: wraps stub calls with wall-clock timing.
 */
export function createObservabilityCaller(options) {
    const { emitMetric } = options;
    return createTransform().caller(() => async ({ method, id, next }) => {
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
        }
        catch (error) {
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
export function createObservabilityCallee(emitMetric) {
    return createTransform().callee(() => async ({ method, next }) => {
        const start = performance.now();
        try {
            const result = await next();
            emitMetric({
                label: "method_ok",
                method,
                durationMs: performance.now() - start,
            });
            return result;
        }
        catch (error) {
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
export function createFullObservability() {
    const callerCalleeFactory = createTransform()
        .caller(() => async ({ method, id, next, context }) => {
        const start = performance.now();
        const result = await next();
        const elapsed = performance.now() - start;
        result.__callerMs = elapsed;
        result.__callerMethod = method;
        result.__callerId = id;
        context.accountId = 0;
        return result;
    })
        .callee(() => async ({ method, next }) => {
        const start = performance.now();
        const result = await next();
        const elapsed = performance.now() - start;
        result.__calleeMs = elapsed;
        result.__calleeMethod = method;
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
/**
 * PRD-style observability using context.
 *
 * Caller side: injects accountId/coloId into context,
 *   records wall-clock ("eyeball") timing.
 * Callee side: reads accountId/coloId from context,
 *   records CPU timing.
 */
export function createContextObservabilityCaller(options) {
    const { accountId, coloId, emitMetric } = options;
    return createTransform().caller(() => async ({ method, id, next }) => {
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
        }
        catch (error) {
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
export function createContextObservabilityCallee(emitMetric) {
    return createTransform().callee(() => async ({ method, context, next }) => {
        const accountId = context.accountId;
        const coloId = context.coloId;
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
        }
        catch (error) {
            emitMetric({
                label: "cpu_error",
                method,
                durationMs: performance.now() - start,
                accountId,
                coloId,
            });
            throw error;
        }
    })();
}
