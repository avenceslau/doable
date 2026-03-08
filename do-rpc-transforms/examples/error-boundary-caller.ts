import { Result, TaggedError } from "better-result";
import { createTransform } from "../src";

export class DegradedRpcError extends TaggedError("DegradedRpcError")<{
	message: string;
	method: string;
}>() {}

export function createErrorBoundaryCaller<TStub extends object>() {
	return createTransform<TStub>().caller(() => {
		return async ({ method, next }) => {
			try {
				return await next();
			} catch (error) {
				if (error instanceof Error && /overload|timeout|degraded/i.test(error.message)) {
					return Result.err(
						new DegradedRpcError({
							message: error.message,
							method,
						})
					);
				}
				throw error;
			}
		};
	})();
}
