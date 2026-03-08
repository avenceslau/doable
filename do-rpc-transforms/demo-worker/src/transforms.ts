import {
	createTransform,
	type TransformContext,
} from "../../src";
import { Result, ResultDeserializationError, TaggedError } from "better-result";

type RateWindowState = {
  windowStart: number;
  count: number;
};

function isResult(value: unknown): value is Result<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		((value as Record<string, unknown>).status === "ok" ||
			(value as Record<string, unknown>).status === "error")
	);
}

export class RateLimitError extends TaggedError("RateLimitError")<{
	message: string;
	method: string;
	retryAfterMs: number;
}>() {}

export const codec = createTransform<object>()
  .callerParams<void>()
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
  .calleeParams<void>()
  .callee(() => async ({ next }) => {
    const value = await next();
    if (isResult(value)) {
      return Result.serialize(value);
    }
    return value;
  });

export const calleeRateLimiter = createTransform<
  object,
  {},
  TransformContext
>().callee((limitedMethod: string, maxCalls: number, windowMs: number) => {
  return async ({ method, instance, next }) => {
    if (method !== limitedMethod) {
      return next();
    }

    const holder = instance as unknown as {
      __rateLimitState?: Map<string, RateWindowState>;
    };

    if (!holder.__rateLimitState) {
      holder.__rateLimitState = new Map<string, RateWindowState>();
    }

    const now = Date.now();
    const key = String(method);
    const current = holder.__rateLimitState.get(key);

    if (!current || now - current.windowStart >= windowMs) {
      holder.__rateLimitState.set(key, { windowStart: now, count: 1 });
      return next();
    }

	if (current.count >= maxCalls) {
		const retryAfterMs = Math.max(0, windowMs - (now - current.windowStart));
		return next({
			result: Result.err(
				new RateLimitError({
					message: `Rate limit exceeded for \"${method}\"`,
					method,
					retryAfterMs,
				})
			),
		});
	}

    current.count += 1;
    return next();
  };
});
