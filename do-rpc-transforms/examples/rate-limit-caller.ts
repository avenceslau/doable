import { Result, TaggedError } from "better-result";
import { createTransform } from "../src";

export class CallerRateLimitError extends TaggedError("CallerRateLimitError")<{
	message: string;
	method: string;
	retryAfterMs: number;
}>() {}

type WindowState = { windowStart: number; count: number };

export function createCallerRateLimit<TStub extends object>() {
	return createTransform<TStub>()
		.callerParams<{ method: string; maxCalls: number; windowMs: number }>()
		.caller(({ method, maxCalls, windowMs }) => {
			const windows = new Map<string, WindowState>();

			return async ({ method: calledMethod, next }) => {
				if (calledMethod !== method) {
					return next();
				}

				const now = Date.now();
				const current = windows.get(calledMethod);

				if (!current || now - current.windowStart >= windowMs) {
					windows.set(calledMethod, { windowStart: now, count: 1 });
					return next();
				}

				if (current.count >= maxCalls) {
					const retryAfterMs = Math.max(0, windowMs - (now - current.windowStart));
					return next({
						result: Result.err(
							new CallerRateLimitError({
								message: `Caller limit exceeded for \"${calledMethod}\"`,
								method: calledMethod,
								retryAfterMs,
							})
						),
					});
				}

				current.count += 1;
				return next();
			};
		});
}
