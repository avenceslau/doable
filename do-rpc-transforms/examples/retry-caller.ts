import { createTransform } from "../src";

export type RetryOptions = {
	retries: number;
	baseDelayMs?: number;
	exponential?: boolean;
};

export function createRetryCaller<TStub extends object>(
	options: RetryOptions | number
) {
	const opts = typeof options === "number" ? { retries: options } : options;
	const { retries, baseDelayMs = 0, exponential = false } = opts;

	return createTransform<TStub>().caller(() => async ({ next }) => {
		let attempt = 0;
		while (true) {
			try {
				return await next();
			} catch (error) {
				attempt += 1;
				if (attempt > retries) {
					throw error;
				}

				if (baseDelayMs > 0) {
					const delay = exponential
						? baseDelayMs * 2 ** (attempt - 1)
						: baseDelayMs;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
	})();
}
