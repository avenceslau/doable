import { createTransform } from "../src";

export type AuthGuardOptions = {
	protectedMethods?: string[];
	tokenExtractor: (args: readonly unknown[]) => string | undefined;
};

export class UnauthorizedError extends Error {
	override name = "UnauthorizedError";
	constructor(method: string) {
		super(`Unauthorized call to ${method}`);
	}
}

export function createAuthGuardCallee<TInstance extends object>(
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
