/**
 * Collocated caller + callee transforms for the MetricsDO pipeline.
 *
 * Each transform is built with `createTransform().caller().callee()` so
 * a single object carries both sides.  The worker entry imports the
 * callee side, and the test file imports the caller side — from the
 * same definition.
 *
 * Full pipeline per call:
 *
 *   caller: metrics → codec → [wire]
 *   callee: metrics → codec → method
 *
 * The metrics caller injects `accountId` into context so
 * the callee can read it and include it in the metric log entry.
 *
 * Usage:
 *   // Caller — .with() reads the `onCall` property
 *   stub.with(metrics("acct-42")).with(codec())
 *
 *   // Callee — register on the class via builder helper
 *   useDOTransforms(MyDO).with(metrics("unused")()).with(codec()()).done()
 */
import { Result, ResultDeserializationError, TaggedError } from "better-result";
import { createTransform } from "../../../src";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isResult(value) {
    return (typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "ok" ||
            value.status === "error"));
}
// ---------------------------------------------------------------------------
// metrics — caller + callee
//
// Caller side: takes an accountId, injects it into context,
// and passes through.
//
// Callee side: reads accountId from context, calls the method,
// and records method, accountId, status, duration, and the result.
// ---------------------------------------------------------------------------
export const metrics = createTransform()
    .caller((accountId) => async ({ next }) => {
    const res = await next({ context: { accountId } });
    return res;
})
    .callee(() => async ({ method, context, instance, next }) => {
    const start = performance.now();
    let status = "ok";
    let result;
    try {
        result = await next();
        if (isResult(result) && Result.isError(result)) {
            status = "error";
        }
    }
    catch (err) {
        status = "error";
        throw err;
    }
    finally {
        const entry = {
            method,
            accountId: context.accountId,
            status,
            durationMs: performance.now() - start,
            result,
        };
        const inst = instance;
        if (!inst.__metricsLog) {
            inst.__metricsLog = [];
        }
        inst.__metricsLog.push(entry);
    }
    return result;
});
// ---------------------------------------------------------------------------
// codec — caller + callee
//
// Callee side: serializes Result values before sending across the wire.
// Caller side: deserializes Result values received from the wire.
// ---------------------------------------------------------------------------
export const codec = createTransform()
    .caller(() => async ({ next }) => {
    const wireValue = await next();
    try {
        const parsed = Result.deserialize(wireValue);
        if (Result.isError(parsed) &&
            ResultDeserializationError.is(parsed.error)) {
            return wireValue;
        }
        return parsed;
    }
    catch {
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
// ---------------------------------------------------------------------------
// singleFlight — caller + callee
//
// Callee side: tracks in-flight methods per method name on the DO
// instance.  If a second call arrives while the first is still running,
// the callee short-circuits with Result.err(MethodBusyError).
//
// Caller side: after the codec deserializes the Result, the caller
// checks for MethodBusyError.  When detected it records a metric log
// entry and returns the Result.err as-is.
//
// Pipeline order:
//   caller: singleFlight → codec → [wire]
//   callee: singleFlight → codec → method
//
// singleFlight uses next({ result }) when busy so downstream
// transforms (codec) still run and serialize the Result.
// ---------------------------------------------------------------------------
export class MethodBusyError extends TaggedError("MethodBusyError")() {
}
/**
 * Detects whether a deserialized error is a MethodBusyError.
 *
 * After RPC round-trip, TaggedError's `_tag` may not survive workerd's
 * structured clone.  We check both `_tag` (if present) and the error
 * `message` pattern as a reliable fallback.
 */
function isMethodBusyError(error) {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    // Prefer _tag when it survives the wire
    if ("_tag" in error &&
        error._tag === "MethodBusyError") {
        return true;
    }
    // Fallback: match the message pattern produced by the callee
    if ("message" in error &&
        typeof error.message === "string") {
        return /^Method ".+" is already running$/.test(error.message);
    }
    return false;
}
// ---------------------------------------------------------------------------
// errorBoundary — caller only
//
// Wraps the RPC call in a try/catch.  Known runtime errors (thrown
// exceptions that match a recognized pattern) are converted to
// Result.err so the caller gets a typed error instead of an exception.
// Unknown errors are forwarded to Sentry and re-wrapped as
// Result.err(UnknownRpcError).
// ---------------------------------------------------------------------------
export class NetworkError extends TaggedError("NetworkError")() {
}
export class TimeoutError extends TaggedError("TimeoutError")() {
}
export class UnknownRpcError extends TaggedError("UnknownRpcError")() {
}
/**
 * Checks if a thrown error matches a known runtime error pattern.
 * Returns a Result.err with the appropriate TaggedError, or undefined
 * if the error is not recognized.
 */
function matchKnownError(err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    if (/network|connection|ECONNREFUSED/i.test(message)) {
        return Result.err(new NetworkError({ message }));
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
        return Result.err(new TimeoutError({ message }));
    }
    return undefined;
}
export const errorBoundary = createTransform().caller((sentryLog) => {
    return async ({ method, next }) => {
        try {
            return await next();
        }
        catch (err) {
            const known = matchKnownError(err);
            if (known) {
                return known;
            }
            // Unknown error — send to Sentry
            sentryLog.push({
                method,
                error: err,
            });
            const message = err instanceof Error ? err.message : "Unknown RPC error";
            return Result.err(new UnknownRpcError({ message }));
        }
    };
});
// ---------------------------------------------------------------------------
// rateLimiter — caller only
//
// Checks an external rate-limit service before making the RPC call.
// Scoped to a single method name — other methods pass through.
// When the limit is exceeded the transform uses next({ result }) so
// downstream caller transforms (metrics, codec) still execute.
// ---------------------------------------------------------------------------
export class RateLimitError extends TaggedError("RateLimitError")() {
}
export const rateLimiter = createTransform().caller((limitedMethod, service) => {
    return async ({ method, next }) => {
        if (method !== limitedMethod) {
            return next();
        }
        const { allowed } = await service.check(method);
        if (!allowed) {
            return Result.err(new RateLimitError({
                message: `Rate limit exceeded for "${method}"`,
                method,
            }));
        }
        return next();
    };
});
export const singleFlight = createTransform()
    .caller((log) => {
    return async ({ method, next }) => {
        const result = await next();
        if (isResult(result) &&
            Result.isError(result) &&
            isMethodBusyError(result.error)) {
            log.push({ method, status: "busy" });
        }
        return result;
    };
})
    .callee(() => async ({ method, instance, next }) => {
    const inst = instance;
    if (!inst.__inflight) {
        inst.__inflight = new Set();
    }
    if (inst.__inflight.has(method)) {
        // Pass the error as a result so downstream transforms
        // (e.g. codec) still run and can serialize it.
        return next({
            result: Result.err(new MethodBusyError({
                message: `Method "${method}" is already running`,
                method,
            })),
        });
    }
    inst.__inflight.add(method);
    try {
        return await next();
    }
    finally {
        inst.__inflight.delete(method);
    }
});
