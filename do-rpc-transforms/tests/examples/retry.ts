/**
 * Retry Transform — caller-side, parameterized
 *
 * Retries failed RPC calls up to N times with optional exponential backoff.
 * This is the most commonly requested pattern from the PRD.
 */
import { createTransform } from "../../src";

export type RetryOptions = {
	retries: number;
	/** Base delay in ms (default 0 = no delay) */
	baseDelay?: number;
	/** Use exponential backoff (default false) */
	exponential?: boolean;
};

export function createRetry<TStub extends object>(
	options: RetryOptions | number
) {
	const opts: RetryOptions =
		typeof options === "number" ? { retries: options } : options;
	const { retries, baseDelay = 0, exponential = false } = opts;

	return createTransform<TStub>().caller(() => async ({ next }) => {
		let attempt = 0;
		while (true) {
			try {
				return await next();
			} catch (error) {
				attempt++;
				if (attempt > retries) {
					throw error;
				}

				if (baseDelay > 0) {
					const delay = exponential
						? baseDelay * 2 ** (attempt - 1)
						: baseDelay;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}
	})();
}
