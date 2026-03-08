import { Result, ResultDeserializationError } from "better-result";
import { createTransform } from "../src";
import type { Result as BetterResult } from "better-result";

function isResult(value: unknown): value is BetterResult<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		((value as Record<string, unknown>).status === "ok" ||
			(value as Record<string, unknown>).status === "error")
	);
}

export function createBetterResultCodec<TStub extends object>() {
	return createTransform<TStub>()
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
}
