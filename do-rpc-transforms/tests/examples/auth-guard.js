/**
 * Auth/Policy Guard — callee-side only
 *
 * Blocks calls to methods that require authorization unless the
 * caller has provided a valid token via an arg or env binding.
 */
import { createTransform } from "../../src";
export class UnauthorizedError extends Error {
    name = "UnauthorizedError";
    constructor(method) {
        super(`Unauthorized call to ${method}`);
    }
}
/**
 * Callee guard: validates a token extracted from args against
 * an `AUTH_SECRET` env binding.
 */
export function createAuthGuard(options) {
    const { protectedMethods, tokenExtractor } = options;
    return createTransform().callee(() => async ({ method, args, env, next }) => {
        const needsAuth = protectedMethods === undefined ||
            protectedMethods.length === 0 ||
            protectedMethods.includes(method);
        if (!needsAuth) {
            return next();
        }
        const token = tokenExtractor(args);
        const secret = env?.AUTH_SECRET;
        if (!secret || token !== secret) {
            throw new UnauthorizedError(method);
        }
        return next();
    })();
}
