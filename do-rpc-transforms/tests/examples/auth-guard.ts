/**
 * Auth/Policy Guard — callee-side only
 *
 * Blocks calls to methods that require authorization unless the
 * caller has provided a valid token via an arg or env binding.
 */
import { createTransform } from "../../src";

export type AuthGuardOptions = {
	/**
	 * Methods that require authorization.
	 * If empty/omitted, all methods require auth.
	 */
	protectedMethods?: string[];
	/** Extracts the token from method arguments */
	tokenExtractor: (args: readonly unknown[]) => string | undefined;
};

export class UnauthorizedError extends Error {
	override name = "UnauthorizedError";
	constructor(method: string) {
		super(`Unauthorized call to ${method}`);
	}
}

/**
 * Callee guard: validates a token extracted from args against
 * an `AUTH_SECRET` env binding.
 */
export function createAuthGuard<TInstance extends object>(
	options: AuthGuardOptions
) {
	const { protectedMethods, tokenExtractor } = options;

	return createTransform<TInstance>().callee(
		() =>
			async ({ method, args, env, next }) => {
				const needsAuth =
					protectedMethods === undefined ||
					protectedMethods.length === 0 ||
					protectedMethods.includes(method);

				if (!needsAuth) {
					return next();
				}

				const token = tokenExtractor(args);
				const secret = (env as Record<string, string> | undefined)?.AUTH_SECRET;

				if (!secret || token !== secret) {
					throw new UnauthorizedError(method);
				}

				return next();
			}
	)();
}
