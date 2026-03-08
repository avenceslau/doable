/**
 * Retry Transform — caller-side, parameterized
 *
 * Retries failed RPC calls up to N times with optional exponential backoff.
 * This is the most commonly requested pattern from the PRD.
 */
import { createTransform } from "../../src";
export function createRetry(options) {
    const opts = typeof options === "number" ? { retries: options } : options;
    const { retries, baseDelay = 0, exponential = false } = opts;
    return createTransform().caller(() => async ({ next }) => {
        let attempt = 0;
        while (true) {
            try {
                return await next();
            }
            catch (error) {
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
