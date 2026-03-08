import { createTransform } from "../src";

function stableKey(method: string, args: readonly unknown[]): string {
	return `${method}:${JSON.stringify(args)}`;
}

export function createSingleInflightCallee<TInstance extends object>() {
	return createTransform<TInstance>()
		.calleeParams<{ methods?: string[] }>()
		.callee(({ methods }) => {
			return async ({ method, args, instance, next }) => {
				const shouldDedupe =
					methods === undefined || methods.length === 0 || methods.includes(method);
				if (!shouldDedupe) {
					return next();
				}

				const holder = instance as {
					__singleInflight?: Map<string, Promise<unknown>>;
				};
				if (!holder.__singleInflight) {
					holder.__singleInflight = new Map<string, Promise<unknown>>();
				}

				const key = stableKey(method, args);
				const existing = holder.__singleInflight.get(key);
				if (existing) {
					return existing;
				}

				const run = Promise.resolve(next()).finally(() => {
					holder.__singleInflight?.delete(key);
				});
				holder.__singleInflight.set(key, run);
				return run;
			};
		});
}
