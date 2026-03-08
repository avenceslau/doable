import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import {
	createTransform,
	TRANSFORM_CALL_ID_CONTEXT_KEY,
	useDOTransforms,
	withCalleeTransforms,
	withTransforms,
} from "../src";
import type { CalleeTransform } from "../src";
import {
	errorBoundary,
	NetworkError,
	rateLimiter,
	singleFlight,
	TimeoutError,
	UnknownRpcError,
} from "./workers/src/transforms";
import type {
	RateLimitService,
	SentryReport,
	SingleFlightMetricEntry,
} from "./workers/src/transforms";

type CounterStub = {
	id: string;
	increment(by: number): Promise<number>;
	failUntil(attempts: number): Promise<string>;
	alwaysFail(): Promise<never>;
};

function createCounterStub(): CounterStub {
	let count = 0;
	let failureCount = 0;

	return {
		id: "counter-1",
		async increment(by: number): Promise<number> {
			count += by;
			return count;
		},
		async failUntil(attempts: number): Promise<string> {
			failureCount += 1;
			if (failureCount < attempts) {
				throw new Error(`failed-${failureCount}`);
			}

			return `ok-${failureCount}`;
		},
		async alwaysFail(): Promise<never> {
			throw new Error("always-fails");
		},
	};
}

/**
 * Creates a mock namespace whose `.get()` calls the provided factory
 * each time, producing a fresh stub.
 */
function mockNamespace<T extends object>(factory: () => T) {
	return {
		newUniqueId: () => ({ toString: () => "mock-id", name: "mock" }),
		idFromName: (name: string) => ({ toString: () => name, name }),
		idFromString: (id: string) => ({ toString: () => id, name: id }),
		get: (_id: unknown) => factory(),
	};
}

// ---------------------------------------------------------------------------
// Caller-side tests
// ---------------------------------------------------------------------------

describe("withTransforms (caller)", () => {
	it("runs transforms in registration order", async () => {
		const events: string[] = [];
		const trace = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`before:${method}`);
					const result = await next();
					events.push(`after:${method}`);
					return result;
				}
		)();

		const ns = withTransforms(mockNamespace(createCounterStub));
		const tracingStub = ns.get("x").with(trace).with(trace);

		const result = await tracingStub.increment(2);

		expect(result).toBe(2);
		expect(events).toEqual([
			"before:increment",
			"before:increment",
			"after:increment",
			"after:increment",
		]);
	});

	it("allows caller transforms to override method arguments", async () => {
		function multiplyArg(multiplier: number) {
			return createTransform<CounterStub>().caller(() => ({ args, next }) => {
				const by = (args as unknown[])[0] as number;
				return next({ args: [by * multiplier] as never });
			})();
		}

		const ns = withTransforms(mockNamespace(createCounterStub));
		const stub = ns.get("x").with(multiplyArg(3));
		const result = await stub.increment(2);

		expect(result).toBe(6);
	});

	it("supports parameterized retry transforms", async () => {
		function retry(retries: number) {
			return createTransform<CounterStub>().caller(() => async ({ next }) => {
				let attempts = 0;
				while (true) {
					try {
						return await next();
					} catch (error) {
						attempts += 1;
						if (attempts > retries) {
							throw error;
						}
					}
				}
			})();
		}

		const ns = withTransforms(mockNamespace(createCounterStub));
		const stub = ns.get("x").with(retry(2));
		await expect(stub.failUntil(2)).resolves.toBe("ok-2");
		await expect(stub.alwaysFail()).rejects.toThrowError("always-fails");
	});

	it("returns the base stub from unwrap", () => {
		const ns = withTransforms(mockNamespace(createCounterStub));
		const wrapped = ns.get("x");

		// unwrap returns the raw stub produced by the namespace
		expect(wrapped.unwrap()).toBeTruthy();
		expect(typeof wrapped.unwrap().increment).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Callee-side tests
// ---------------------------------------------------------------------------

type CounterDO = {
	count: number;
	increment(by: number): Promise<number>;
	getCount(): Promise<number>;
};

function createCounterDO(): CounterDO {
	const obj: CounterDO = {
		count: 0,
		async increment(by: number): Promise<number> {
			obj.count += by;
			return obj.count;
		},
		async getCount(): Promise<number> {
			return obj.count;
		},
	};

	return obj;
}

describe("withCalleeTransforms (callee)", () => {
	it("runs callee transforms before the actual method", async () => {
		const events: string[] = [];
		const logging = createTransform<CounterDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(`callee:before:${method}`);
					const result = await next();
					events.push(`callee:after:${method}`);
					return result;
				}
		)();

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [logging]);

		const result = await wrapped.increment(5);

		expect(result).toBe(5);
		expect(events).toEqual([
			"callee:before:increment",
			"callee:after:increment",
		]);
	});

	it("runs multiple callee transforms in order", async () => {
		const events: string[] = [];

		const first = createTransform<CounterDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(`first:before:${method}`);
					const result = await next();
					events.push(`first:after:${method}`);
					return result;
				}
		)();

		const second = createTransform<CounterDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(`second:before:${method}`);
					const result = await next();
					events.push(`second:after:${method}`);
					return result;
				}
		)();

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [first, second]);

		await wrapped.increment(1);

		expect(events).toEqual([
			"first:before:increment",
			"second:before:increment",
			"second:after:increment",
			"first:after:increment",
		]);
	});

	it("callee transforms can override arguments", async () => {
		const doubleArgs = createTransform<CounterDO>().callee(
			() =>
				async ({ args, next }) => {
					const by = (args as unknown[])[0] as number;
					return next({ args: [by * 2] as never });
				}
		)();

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [doubleArgs]);

		const result = await wrapped.increment(3);

		expect(result).toBe(6);
	});

	it("callee transforms receive state and env from options", async () => {
		let capturedState: unknown;
		let capturedEnv: unknown;

		const inspector = createTransform<CounterDO>().callee(
			() =>
				async ({ state, env, next }) => {
					capturedState = state;
					capturedEnv = env;
					return next();
				}
		)();

		const fakeState = { id: "state-123" };
		const fakeEnv = { MY_KV: "kv-binding" };

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [inspector], {
			state: fakeState,
			env: fakeEnv,
		});

		await wrapped.increment(1);

		expect(capturedState).toBe(fakeState);
		expect(capturedEnv).toBe(fakeEnv);
	});

	it("callee transforms receive the instance reference", async () => {
		let capturedInstance: unknown;

		const inspector = createTransform<CounterDO>().callee(
			() =>
				async ({ instance, next }) => {
					capturedInstance = instance;
					return next();
				}
		)();

		const doInstance = createCounterDO();
		const wrapped = withCalleeTransforms(doInstance, [inspector]);

		await wrapped.increment(1);

		expect(capturedInstance).toBe(doInstance);
	});

	it("returns instance unchanged when transforms list is empty", () => {
		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, []);

		expect(wrapped).toBe(instance);
	});

	it("callee transforms can short-circuit (skip next)", async () => {
		const blocker = createTransform<CounterDO>().callee(() => async () => {
			return -1;
		})();

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [blocker]);

		const result = await wrapped.increment(100);

		expect(result).toBe(-1);
		expect(instance.count).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// next({ result }) — short-circuit while continuing the pipeline
// ---------------------------------------------------------------------------

describe("next({ result }) short-circuit", () => {
	describe("callee-side", () => {
		it("skips the method but downstream transforms still run", async () => {
			const events: string[] = [];

			const guard = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						events.push("guard");
						return next({ result: 42 });
					}
			)();

			const logger = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						events.push("logger:before");
						const result = await next();
						events.push(`logger:after:${result}`);
						return result;
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [guard, logger]);

			const result = await wrapped.increment(100);

			// Method was never called — count stays at 0
			expect(instance.count).toBe(0);
			// The provided result (42) flows through the rest of the pipeline
			expect(result).toBe(42);
			// Both transforms ran, but the logger saw the short-circuited value
			expect(events).toEqual(["guard", "logger:before", "logger:after:42"]);
		});

		it("downstream transform can modify the short-circuited result", async () => {
			const guard = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						return next({ result: 10 });
					}
			)();

			const doubler = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						const result = await next();
						return (result as number) * 2;
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [guard, doubler]);

			const result = await wrapped.increment(999);

			expect(instance.count).toBe(0);
			expect(result).toBe(20); // 10 * 2
		});

		it("preserves context through the short-circuit", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const injector = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						return next({
							result: "skipped",
							context: { origin: "injector" },
						});
					}
			)();

			const inspector = createTransform<CounterDO>().callee(
				() =>
					async ({ context, next }) => {
						capturedCtx = { ...context };
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [injector, inspector]);

			await wrapped.increment(1);

			expect(capturedCtx).toMatchObject({ origin: "injector" });
		});

		it("normal pipeline is unaffected when result is not provided", async () => {
			const passthrough = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [passthrough]);

			const result = await wrapped.increment(7);

			expect(result).toBe(7);
			expect(instance.count).toBe(7);
		});
	});

	describe("caller-side", () => {
		it("skips the RPC call but downstream transforms still run", async () => {
			const events: string[] = [];

			const ns = withTransforms(mockNamespace(() => createCounterStub()));
			const id = ns.idFromName("test");

			const guard = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						events.push("guard");
						return next({ result: 99 });
					}
			)();

			const logger = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						events.push("logger:before");
						const result = await next();
						events.push(`logger:after:${result}`);
						return result;
					}
			)();

			const stub = ns.get(id).with(guard).with(logger);
			const result = await stub.increment(1);

			expect(result).toBe(99);
			expect(events).toEqual(["guard", "logger:before", "logger:after:99"]);
		});
	});
});

// ---------------------------------------------------------------------------
// Full transform (caller + callee in one definition)
// ---------------------------------------------------------------------------

describe("createTransform with caller + callee", () => {
	it("creates a full transform with both sides", () => {
		const callerCalleeFactory = createTransform<CounterDO>()
			.caller(() => async ({ next }) => {
				return next();
			})
			.callee(() => async ({ next }) => {
				return next();
			});

		// callerCalleeFactory is: () => ((...calleeArgs) => CalleeTransform) & CallerTransform
		const combined = callerCalleeFactory();
		const calleeTransform = combined();
		const fullTransform = {
			onCall: combined.onCall,
			onReceive: calleeTransform.onReceive,
		};

		expect(fullTransform.onCall).toBeTypeOf("function");
		expect(fullTransform.onReceive).toBeTypeOf("function");
	});
});

// ---------------------------------------------------------------------------
// Full transform: callee().caller() ordering (reverse of caller().callee())
// ---------------------------------------------------------------------------

describe("createTransform with callee().caller()", () => {
	it("creates a full transform with both sides (callee-first ordering)", () => {
		const callerCalleeFactory = createTransform<CounterDO>()
			.callee(() => async ({ next }) => {
				return next();
			})
			.caller(() => async ({ next }) => {
				return next();
			});

		// callerCalleeFactory is: (...callerArgs) => ((...calleeArgs) => CalleeTransform) & CallerTransform
		const combined = callerCalleeFactory();
		const calleeTransform = combined();
		const fullTransform = {
			onCall: combined.onCall,
			onReceive: calleeTransform.onReceive,
		};

		expect(fullTransform.onCall).toBeTypeOf("function");
		expect(fullTransform.onReceive).toBeTypeOf("function");
	});

	it("callee().caller() and caller().callee() produce same runtime shape", () => {
		const callerFirst = createTransform<CounterDO>()
			.caller(
				() =>
					async ({ next }) =>
						next()
			)
			.callee(
				() =>
					async ({ next }) =>
						next()
			);

		const calleeFirst = createTransform<CounterDO>()
			.callee(
				() =>
					async ({ next }) =>
						next()
			)
			.caller(
				() =>
					async ({ next }) =>
						next()
			);

		const cf = callerFirst();
		const cc = calleeFirst();

		// Both have onCall at the top level
		expect(cf.onCall).toBeTypeOf("function");
		expect(cc.onCall).toBeTypeOf("function");

		// Both are callable to get callee transform
		expect(cf).toBeTypeOf("function");
		expect(cc).toBeTypeOf("function");

		// Both produce onReceive when called
		const cfCallee = cf();
		const ccCallee = cc();
		expect(cfCallee.onReceive).toBeTypeOf("function");
		expect(ccCallee.onReceive).toBeTypeOf("function");
	});

	it("callee().caller() with parameterized factories", () => {
		const transform = createTransform<CounterDO>()
			.callee((prefix: string) => async ({ next }) => {
				void prefix;
				return next();
			})
			.caller((retries: number) => async ({ next }) => {
				void retries;
				return next();
			});

		// First call = caller args (retries)
		const combined = transform(3);
		expect(combined.onCall).toBeTypeOf("function");

		// Second call = callee args (prefix)
		const callee = combined("test-");
		expect(callee.onReceive).toBeTypeOf("function");
	});

	it("callee-only usage still works after .caller() is available", () => {
		const calleeOnly = createTransform<CounterDO>().callee(
			() =>
				async ({ next }) =>
					next()
		);

		// Should be callable without .caller()
		const transform = calleeOnly();
		expect(transform.onReceive).toBeTypeOf("function");

		// .caller should be available
		expect(calleeOnly.caller).toBeTypeOf("function");
	});

	it("callee().caller() runs callee handler correctly with withCalleeTransforms", async () => {
		const log: string[] = [];

		const transform = createTransform<CounterDO>()
			.callee(() => async ({ method, next }) => {
				log.push(`callee:${method}`);
				return next();
			})
			.caller(() => async ({ next }) => {
				return next();
			});

		const combined = transform();
		const calleeTransform = combined();

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [calleeTransform]);

		const result = await wrapped.increment(5);
		expect(result).toBe(5);
		expect(log).toContain("callee:increment");
	});

	it("callee().caller() onCall works in a caller pipeline via withTransforms", async () => {
		const log: string[] = [];

		const transform = createTransform<CounterStub>()
			.callee(() => async ({ next }) => {
				return next();
			})
			.caller(() => async ({ method, next }) => {
				log.push(`caller:${method}`);
				return next();
			});

		const combined = transform();

		// combined has onCall (caller) + is callable for callee
		expect(combined.onCall).toBeTypeOf("function");
		expect(combined).toBeTypeOf("function");

		// The callee side
		const callee = combined();
		expect(callee.onReceive).toBeTypeOf("function");
	});
});

// ---------------------------------------------------------------------------
// Parameterized callee transform (plain function)
// ---------------------------------------------------------------------------

describe("parameterized callee transform", () => {
	it("creates parameterized callee transforms via plain function", async () => {
		function clamp(max: number) {
			return createTransform<CounterDO>().callee(
				() =>
					async ({ args, next }) => {
						const by = (args as unknown[])[0] as number;
						const clamped = Math.min(by, max);
						return next({ args: [clamped] as never });
					}
			)();
		}

		const instance = createCounterDO();
		const wrapped = withCalleeTransforms(instance, [clamp(10)]);

		const result = await wrapped.increment(50);
		expect(result).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// createTransform with split caller/callee params
// ---------------------------------------------------------------------------

describe("createTransform split params", () => {
	it("supports different caller and callee parameter sets", async () => {
		const callerSeen: Array<{ traceId: string; method: string }> = [];
		const calleeSeen: Array<{ max: number; method: string }> = [];

		const typed = createTransform<CounterDO>()
			.callerParams<{ traceId: string }>()
			.caller(({ traceId }) => async ({ method, next }) => {
				callerSeen.push({ traceId, method: String(method) });
				return next({ context: { traceId } });
			})
			.calleeParams<{ max: number }>()
			.callee(({ max }) => async ({ method, args, next }) => {
				calleeSeen.push({ max, method: String(method) });
				const by = (args as unknown[])[0] as number;
				return next({ args: [Math.min(by, max)] as never });
			});

		const wrapped = withCalleeTransforms(createCounterDO(), [
			typed.calleeConfig({ max: 3 }),
		]);
		const ns = withTransforms(mockNamespace(() => wrapped));
		const stub = ns.get("x").with(typed.callerConfig({ traceId: "t-1" }));

		const result = await stub.increment(10);

		expect(result).toBe(3);
		expect(callerSeen).toEqual([{ traceId: "t-1", method: "increment" }]);
		expect(calleeSeen).toEqual([{ max: 3, method: "increment" }]);
	});

	it("supports paramless caller/callee config", async () => {
		const typed = createTransform<CounterDO>()
			.callerParams<void>()
			.caller(() => async ({ next }) => next())
			.calleeParams<void>()
			.callee(() => async ({ next }) => next());

		const wrapped = withCalleeTransforms(createCounterDO(), [
			typed.calleeConfig(),
		]);
		const ns = withTransforms(mockNamespace(() => wrapped));
		const stub = ns.get("x").with(typed.callerConfig());

		const result = await stub.increment(2);
		expect(result).toBe(2);
	});

	it("allows passing paramless split transform directly to with()", async () => {
		const typed = createTransform<CounterDO>()
			.callerParams<void>()
			.caller(() => async ({ next }) => next())
			.calleeParams<void>()
			.callee(() => async ({ next }) => next());

		const wrapped = withCalleeTransforms(createCounterDO(), [typed]);
		const ns = withTransforms(mockNamespace(() => wrapped));
		const stub = ns.get("x").with(typed);

		const result = await stub.increment(4);
		expect(result).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

describe("context", () => {
	describe("caller-side", () => {
		it("starts with an empty context", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const inspector = createTransform<CounterStub>().caller(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const ns = withTransforms(mockNamespace(createCounterStub));
			const stub = ns.get("x").with(inspector);
			await stub.increment(1);

			expect(capturedCtx).toMatchObject({});
			expect(capturedCtx?.[TRANSFORM_CALL_ID_CONTEXT_KEY]).toEqual(
				expect.any(String)
			);
		});

		it("passes context through next()", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const injector = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { traceId: "abc-123" } });
					}
			)();

			const reader = createTransform<CounterStub>().caller(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const ns = withTransforms(mockNamespace(createCounterStub));
			const stub = ns.get("x").with(injector).with(reader);

			await stub.increment(1);

			expect(capturedCtx).toMatchObject({ traceId: "abc-123" });
		});

		it("merges context from multiple transforms", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const addTrace = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { traceId: "t1" } });
					}
			)();

			const addAccount = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { accountId: "a1" } });
					}
			)();

			const reader = createTransform<CounterStub>().caller(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const ns = withTransforms(mockNamespace(createCounterStub));
			const stub = ns.get("x").with(addTrace).with(addAccount).with(reader);

			await stub.increment(1);

			expect(capturedCtx).toMatchObject({ traceId: "t1", accountId: "a1" });
		});

		it("later transforms override earlier keys", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const first = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { key: "first" } });
					}
			)();

			const second = createTransform<CounterStub>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { key: "second" } });
					}
			)();

			const reader = createTransform<CounterStub>().caller(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const ns = withTransforms(mockNamespace(createCounterStub));
			const stub = ns.get("x").with(first).with(second).with(reader);

			await stub.increment(1);

			expect(capturedCtx).toMatchObject({ key: "second" });
		});
	});

	describe("callee-side", () => {
		it("receives context from caller envelope", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const injector = createTransform<CounterDO>().caller(
				() =>
					async ({ next }) => {
						return next({
							context: {
								traceId: "trace-1",
								accountId: "acct-1",
							},
						});
					}
			)();

			const reader = createTransform<CounterDO>().callee(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [reader]);
			const ns = withTransforms(mockNamespace(() => wrapped));
			const stub = ns.get("x").with(injector);

			await stub.increment(5);

			expect(capturedCtx).toMatchObject({
				traceId: "trace-1",
				accountId: "acct-1",
			});
		});

		it("callee transforms can add to context", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const injector = createTransform<CounterDO>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { from: "caller" } });
					}
			)();

			const calleeInjector = createTransform<CounterDO>().callee(
				() =>
					async ({ next }) => {
						return next({ context: { from2: "callee" } });
					}
			)();

			const calleeReader = createTransform<CounterDO>().callee(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [
				calleeInjector,
				calleeReader,
			]);
			const ns = withTransforms(mockNamespace(() => wrapped));
			const stub = ns.get("x").with(injector);

			await stub.increment(5);

			expect(capturedCtx).toMatchObject({ from: "caller", from2: "callee" });
		});

		it("receives empty context when caller sends no context", async () => {
			let capturedCtx: Record<string, unknown> | undefined;

			const reader = createTransform<CounterDO>().callee(
				() =>
					async ({ context, next }) => {
						capturedCtx = context;
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [reader]);

			// Call without withTransforms — no envelope
			await wrapped.increment(5);

			expect(capturedCtx).toMatchObject({});
			expect(capturedCtx?.[TRANSFORM_CALL_ID_CONTEXT_KEY]).toEqual(
				expect.any(String)
			);
		});

		it("receives id from the instance", async () => {
			let capturedId: unknown;

			const inspector = createTransform<CounterDO>().callee(
				() =>
					async ({ id, next }) => {
						capturedId = id;
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [inspector]);

			await wrapped.increment(1);

			// CounterDO doesn't have an `id` property, so it falls back
			// to reading from state (which is undefined here)
			expect(capturedId).toBeUndefined();
		});

		it("receives id from state when instance has no id", async () => {
			let capturedId: unknown;

			const inspector = createTransform<CounterDO>().callee(
				() =>
					async ({ id, next }) => {
						capturedId = id;
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [inspector], {
				state: { id: "state-id-123" },
			});

			await wrapped.increment(1);

			expect(capturedId).toBe("state-id-123");
		});
	});

	describe("round-trip", () => {
		it("full caller ��� callee → method round-trip preserves args and context", async () => {
			let callerSeenCtx: Record<string, unknown> | undefined;
			let calleeSeenCtx: Record<string, unknown> | undefined;

			const callerInject = createTransform<CounterDO>().caller(
				() =>
					async ({ next }) => {
						return next({
							context: { requestId: "req-1", coloId: "DFW" },
						});
					}
			)();

			const callerRead = createTransform<CounterDO>().caller(
				() =>
					async ({ context, next }) => {
						callerSeenCtx = { ...context };
						return next();
					}
			)();

			const calleeRead = createTransform<CounterDO>().callee(
				() =>
					async ({ context, next }) => {
						calleeSeenCtx = { ...context };
						return next();
					}
			)();

			const instance = createCounterDO();
			const wrapped = withCalleeTransforms(instance, [calleeRead]);
			const ns = withTransforms(mockNamespace(() => wrapped));
			const stub = ns.get("x").with(callerInject).with(callerRead);

			const result = await stub.increment(7);

			expect(result).toBe(7);
			expect(callerSeenCtx).toMatchObject({
				requestId: "req-1",
				coloId: "DFW",
			});
			expect(calleeSeenCtx).toMatchObject({
				requestId: "req-1",
				coloId: "DFW",
			});
		});

		it("method receives clean args, not the envelope", async () => {
			const receivedArgs: unknown[] = [];

			const instance = {
				async echo(...args: unknown[]): Promise<unknown[]> {
					receivedArgs.push(...args);
					return args;
				},
			};

			const inject = createTransform<typeof instance>().caller(
				() =>
					async ({ next }) => {
						return next({ context: { secret: "hidden" } });
					}
			)();

			const passthrough = createTransform<typeof instance>().callee(
				() =>
					async ({ next }) => {
						return next();
					}
			)();

			const wrapped = withCalleeTransforms(instance, [passthrough]);
			const ns = withTransforms(mockNamespace(() => wrapped));
			const stub = ns.get("x").with(inject);

			const result = await stub.echo("hello", 42);

			// The method should see the original args, not the envelope
			expect(receivedArgs).toEqual(["hello", 42]);
			expect(result).toEqual(["hello", 42]);
		});
	});
});

// ---------------------------------------------------------------------------
// Inline .with() — bare async function
// ---------------------------------------------------------------------------

describe("inline .with() with bare handler", () => {
	it("accepts a bare async function as a caller transform", async () => {
		const events: string[] = [];
		const ns = withTransforms(mockNamespace(createCounterStub));

		const stub = ns.get("x").with(async ({ method, next }) => {
			events.push(`inline:${method}`);
			return next();
		});

		const result = await stub.increment(3);

		expect(result).toBe(3);
		expect(events).toEqual(["inline:increment"]);
	});

	it("inline handler can modify args via next()", async () => {
		const ns = withTransforms(mockNamespace(createCounterStub));
		const stub = ns.get("x").with(async ({ args, next }) => {
			const by = (args as unknown[])[0] as number;
			return next({ args: [by * 10] as never });
		});

		const result = await stub.increment(2);
		expect(result).toBe(20);
	});

	it("inline handler can inject context", async () => {
		let capturedCtx: Record<string, unknown> | undefined;

		const reader = createTransform<CounterStub>().caller(
			() =>
				async ({ context, next }) => {
					capturedCtx = context;
					return next();
				}
		)();

		const ns = withTransforms(mockNamespace(createCounterStub));
		const stub = ns
			.get("x")
			.with(async ({ next }) => {
				return next({ context: { from: "inline" } });
			})
			.with(reader);

		await stub.increment(1);

		expect(capturedCtx).toMatchObject({ from: "inline" });
	});

	it("can chain inline handlers with transform objects", async () => {
		const events: string[] = [];

		const objectTransform = createTransform<CounterStub>().caller(
			() =>
				async ({ next }) => {
					events.push("object");
					return next();
				}
		)();

		const ns = withTransforms(mockNamespace(createCounterStub));
		const stub = ns
			.get("x")
			.with(async ({ next }) => {
				events.push("inline-1");
				return next();
			})
			.with(objectTransform)
			.with(async ({ next }) => {
				events.push("inline-2");
				return next();
			});

		await stub.increment(1);

		expect(events).toEqual(["inline-1", "object", "inline-2"]);
	});
});

// ---------------------------------------------------------------------------
// Granular callee transforms via builder
// ---------------------------------------------------------------------------

describe("useDOTransforms builder", () => {
	it("applies class decorator transforms to methods", async () => {
		const events: string[] = [];

		const logging = createTransform<ClassDecoratedDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(String(method));
					return next();
				}
		)();

		class ClassDecoratedDO {
			async a(): Promise<string> {
				return "a";
			}

			async b(): Promise<string> {
				return "b";
			}
		}

		useDOTransforms(ClassDecoratedDO).with(logging).done();

		const instance = new ClassDecoratedDO();
		await instance.a();
		await instance.b();

		expect(events).toEqual(["a", "b"]);
	});

	it("inherits class decorator transforms base-first", async () => {
		const events: string[] = [];

		const baseLog = createTransform<BaseDecoratedDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(`base:${String(method)}`);
					return next();
				}
		)();

		const derivedLog = createTransform<DerivedDecoratedDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(`derived:${String(method)}`);
					return next();
				}
		)();

		class BaseDecoratedDO {
			async ping(): Promise<string> {
				return "pong";
			}
		}

		class DerivedDecoratedDO extends BaseDecoratedDO {}

		useDOTransforms(BaseDecoratedDO).with(baseLog).done();
		useDOTransforms(DerivedDecoratedDO).with(derivedLog).done();

		const instance = new DerivedDecoratedDO();
		await instance.ping();

		expect(events).toEqual(["base:ping", "derived:ping"]);
	});

	it("applies transforms only to the decorated method", async () => {
		const events: string[] = [];

		class DecoratedDO {
			async plain(): Promise<string> {
				return "plain";
			}

			async decorated(): Promise<string> {
				return "decorated";
			}
		}

		const trackDecorated = createTransform<DecoratedDO>().callee(
			() =>
				async ({ method, next }) => {
					events.push(String(method));
					return next();
				}
		)();

		useDOTransforms(DecoratedDO).method("decorated").with(trackDecorated).done();

		const instance = new DecoratedDO();
		await instance.plain();
		await instance.decorated();

		expect(events).toEqual(["decorated"]);
	});

	it("pipelines addTransformContext from instance and transforms", async () => {
		type ContextShape = {
			requestId?: string;
			fromInstance?: string;
			fromTransform?: string;
		};

		let capturedContext: Record<string, unknown> | undefined;

		const callerContext = createTransform<ContextualDO>().caller(
			() =>
				async ({ next }) => {
					return next({ context: { requestId: "req-1" } });
				}
		)();

		class ContextualDO {
			async addTransformContext(context: ContextShape) {
				return {
					fromInstance: `inst-${context.requestId ?? "missing"}`,
				};
			}

			async work(): Promise<string> {
				return "ok";
			}
		}

		const contextReader = createTransform<ContextualDO, {}, ContextShape>()
			.callee(() => async ({ context, next }) => {
				capturedContext = { ...context };
				return next();
			})();

		const contextTransform = {
			...contextReader,
			addTransformContext(context: ContextShape) {
				return {
					fromTransform: `tx-${context.requestId ?? "missing"}`,
				};
			},
		};

		useDOTransforms(ContextualDO).with(
			contextTransform as CalleeTransform<ContextualDO, ContextShape>
		).done();

		const ns = withTransforms(mockNamespace(() => new ContextualDO()));
		const result = await ns.get("x").with(callerContext).work();

		expect(result).toBe("ok");
		expect(capturedContext).toMatchObject({
			requestId: "req-1",
			fromInstance: "inst-req-1",
			fromTransform: "tx-req-1",
		});
	});

	it("reads state/env from instance when available", async () => {
		let capturedState: unknown;
		let capturedEnv: unknown;

		const inspector = createTransform<StateEnvDO>().callee(
			() =>
				async ({ state, env, next }) => {
					capturedState = state;
					capturedEnv = env;
					return next();
				}
		)();

		class StateEnvDO {
			ctx = { id: "ctx-1" };
			env = { TEST: "env" };

			async work(): Promise<string> {
				return "ok";
			}
		}

		useDOTransforms(StateEnvDO).with(inspector).done();

		const instance = new StateEnvDO();
		await instance.work();

		expect(capturedState).toEqual({ id: "ctx-1" });
		expect(capturedEnv).toEqual({ TEST: "env" });
	});

	it("attaches a unique call id in context per caller invocation", async () => {
		const callIds: string[] = [];
		const callerMetadata = createTransform<CallIdDO>().caller(
			() =>
				async ({ next }) => {
					return next({ context: { tagged: true } });
				}
		)();

		class CallIdDO {
			async work(): Promise<string> {
				return "ok";
			}
		}

		const captureCallId = createTransform<CallIdDO>().callee(
			() =>
				async ({ context, next }) => {
					const callId = context[TRANSFORM_CALL_ID_CONTEXT_KEY];
					if (typeof callId === "string") {
						callIds.push(callId);
					}
					return next();
				}
		)();

		useDOTransforms(CallIdDO).with(captureCallId).done();

		const ns = withTransforms(mockNamespace(() => new CallIdDO()));
		await ns.get("x").with(callerMetadata).work();
		await ns.get("x").with(callerMetadata).work();

		expect(callIds).toHaveLength(2);
		expect(callIds[0]).not.toBe(callIds[1]);
		expect(callIds[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
	});

	it("preserves generated call id even if a transform tries overriding it", async () => {
		let capturedCallId: string | undefined;

		class ProtectedCallIdDO {
			async work(): Promise<string> {
				return "ok";
			}
		}

		const overrideAttempt = createTransform<ProtectedCallIdDO>().caller(
			() =>
				async ({ next }) => {
					return next({
						context: {
							tagged: true,
							[TRANSFORM_CALL_ID_CONTEXT_KEY]: "forced-id",
						},
					});
				}
		)();

		const captureCallId = createTransform<ProtectedCallIdDO>().callee(
			() =>
				async ({ context, next }) => {
					const callId = context[TRANSFORM_CALL_ID_CONTEXT_KEY];
					capturedCallId = typeof callId === "string" ? callId : undefined;
					return next();
				}
		)();

		useDOTransforms(ProtectedCallIdDO).with(captureCallId).done();

		const ns = withTransforms(mockNamespace(() => new ProtectedCallIdDO()));
		await ns.get("x").with(overrideAttempt).work();

		expect(capturedCallId).toBeDefined();
		expect(capturedCallId).not.toBe("forced-id");
	});
});

// ---------------------------------------------------------------------------
// Namespace proxy
// ---------------------------------------------------------------------------

type MockId = { toString(): string; name: string };

function createMockId(name: string): MockId {
	return { toString: () => `id:${name}`, name };
}

function createMockNamespace() {
	function createStub(name: string): CounterStub {
		let count = 0;
		return {
			id: `stub:${name}`,
			async increment(by: number): Promise<number> {
				count += by;
				return count;
			},
			async failUntil(attempts: number): Promise<string> {
				throw new Error(`not-implemented`);
			},
			async alwaysFail(): Promise<never> {
				throw new Error("always-fails");
			},
		};
	}

	const ns = {
		newUniqueId() {
			return createMockId(`unique-${Math.random().toString(36).slice(2)}`);
		},
		idFromName(name: string) {
			return createMockId(name);
		},
		idFromString(id: string) {
			return createMockId(id);
		},
		get(id: MockId) {
			return createStub(id.name);
		},
		getByName(name: string) {
			return createStub(name);
		},
		getExisting(id: MockId) {
			return createStub(id.name);
		},
		jurisdiction(_j: string) {
			// Return itself for simplicity
			return ns;
		},
	};

	return ns;
}

describe("withTransforms (namespace proxy)", () => {
	it("detects a namespace and returns a TransformedNamespace", () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		// Should still have namespace methods
		expect(typeof wrapped.idFromName).toBe("function");
		expect(typeof wrapped.idFromString).toBe("function");
		expect(typeof wrapped.newUniqueId).toBe("function");
		expect(typeof wrapped.get).toBe("function");
	});

	it(".get() returns a stub with .with() support", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const id = wrapped.idFromName("test-1");
		const stub = wrapped.get(id);

		// Should have .with() and .unwrap()
		expect(typeof stub.with).toBe("function");
		expect(typeof stub.unwrap).toBe("function");

		// Should still work as a normal stub
		const result = await stub.increment(5);
		expect(result).toBe(5);
	});

	it(".get().with(transform) applies caller transforms", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const events: string[] = [];
		const trace = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`before:${method}`);
					const result = await next();
					events.push(`after:${method}`);
					return result;
				}
		)();

		const id = wrapped.idFromName("test-2");
		const stub = wrapped.get(id).with(trace);

		const result = await stub.increment(3);
		expect(result).toBe(3);
		expect(events).toEqual(["before:increment", "after:increment"]);
	});

	it("chains multiple transforms via .with().with()", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const events: string[] = [];

		const first = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`first:${method}`);
					return next();
				}
		)();

		const second = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`second:${method}`);
					return next();
				}
		)();

		const id = wrapped.idFromName("test-3");
		const stub = wrapped.get(id).with(first).with(second);

		await stub.increment(1);
		expect(events).toEqual(["first:increment", "second:increment"]);
	});

	it("inline handler works with namespace proxy stubs", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const events: string[] = [];
		const id = wrapped.idFromName("test-4");
		const stub = wrapped.get(id).with(async ({ method, next }) => {
			events.push(`inline:${method}`);
			return next();
		});

		const result = await stub.increment(7);
		expect(result).toBe(7);
		expect(events).toEqual(["inline:increment"]);
	});

	it(".getByName() returns a transformed stub", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const events: string[] = [];
		const trace = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`trace:${method}`);
					return next();
				}
		)();

		const stub = wrapped.getByName("counter-1").with(trace);
		const result = await stub.increment(2);

		expect(result).toBe(2);
		expect(events).toEqual(["trace:increment"]);
	});

	it(".getExisting() returns a transformed stub", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const events: string[] = [];
		const trace = createTransform<CounterStub>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`trace:${method}`);
					return next();
				}
		)();

		const id = wrapped.idFromName("existing-1");
		const stub = wrapped.getExisting(id).with(trace);
		const result = await stub.increment(4);

		expect(result).toBe(4);
		expect(events).toEqual(["trace:increment"]);
	});

	it(".jurisdiction() returns a new TransformedNamespace", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const euNs = wrapped.jurisdiction("eu");
		const id = euNs.idFromName("eu-counter");
		const stub = euNs.get(id);

		// Should still have .with()
		expect(typeof stub.with).toBe("function");
		const result = await stub.increment(9);
		expect(result).toBe(9);
	});

	it(".unwrap() on a namespace-produced stub returns the raw stub", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		const id = wrapped.idFromName("unwrap-test");
		const stub = wrapped.get(id);
		const raw = stub.unwrap();

		// Raw stub should not have .with()
		expect("with" in raw).toBe(false);

		// But should still work
		const result = await raw.increment(1);
		expect(result).toBe(1);
	});

	it("transforms inject context through namespace proxy stubs", async () => {
		const ns = createMockNamespace();
		const wrapped = withTransforms(ns);

		let capturedCtx: Record<string, unknown> | undefined;

		const injector = createTransform<CounterStub>().caller(
			() =>
				async ({ next }) => {
					return next({ context: { traceId: "ns-trace-1" } });
				}
		)();

		const reader = createTransform<CounterStub>().caller(
			() =>
				async ({ context, next }) => {
					capturedCtx = context;
					return next();
				}
		)();

		const id = wrapped.idFromName("ctx-test");
		const stub = wrapped.get(id).with(injector).with(reader);
		await stub.increment(1);

		expect(capturedCtx).toMatchObject({ traceId: "ns-trace-1" });
	});
});

// ---------------------------------------------------------------------------
// Full caller pipeline with mock stubs
//
// Exercises the complete caller transform stack:
//   errorBoundary → singleFlight → rateLimiter → metrics → codec
//
// Uses mock stubs that throw known/unknown errors so we can test
// errorBoundary without workerd's isolated storage limitations.
// ---------------------------------------------------------------------------

/**
 * Mock stub for testing the full caller pipeline.
 *
 * Methods that throw at runtime are typed as returning `Result<never, Error>`
 * because errorBoundary catches the throw and converts to Result.err.
 *
 * `increment` can also be short-circuited by rateLimiter, so its return
 * type is a union of the normal value and Result.
 */
type PipelineStub = {
	id: string;
	increment(by: number): Promise<number | Result<never, Error>>;
	slowWork(delayMs: number): Promise<number>;
	failWithNetwork(): Promise<Result<never, Error>>;
	failWithTimeout(): Promise<Result<never, Error>>;
	failWithUnknown(): Promise<Result<never, Error>>;
};

function createPipelineStub(): PipelineStub {
	let count = 0;

	return {
		id: "pipeline-1",
		async increment(by: number) {
			count += by;
			return count;
		},
		async slowWork(delayMs: number) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			count += 1;
			return count;
		},
		async failWithNetwork() {
			throw new Error("connection refused: ECONNREFUSED");
		},
		async failWithTimeout() {
			throw new Error("request timed out: ETIMEDOUT");
		},
		async failWithUnknown() {
			throw new Error("something completely unexpected");
		},
	};
}

describe("full caller pipeline (errorBoundary + singleFlight + rateLimiter + metrics + codec)", () => {
	function buildStub(overrides?: {
		sentryLog?: SentryReport[];
		sfLog?: SingleFlightMetricEntry[];
		rlService?: RateLimitService;
	}) {
		const sentryLog = overrides?.sentryLog ?? [];
		const sfLog = overrides?.sfLog ?? [];
		const allowAll: RateLimitService = {
			async check() {
				return { allowed: true };
			},
		};
		const rlService = overrides?.rlService ?? allowAll;

		const ns = withTransforms(mockNamespace(() => createPipelineStub()));
		const id = ns.idFromName("test");

		// errorBoundary → singleFlight → rateLimiter("increment") → codec
		// metrics is omitted here because it injects context
		// which requires callee-side envelope decoding (not available
		// on mock stubs).  Metrics is tested in worker integration tests.
		const stub = ns
			.get(id)
			.with(errorBoundary(sentryLog))
			.with(singleFlight(sfLog))
			.with(rateLimiter("increment", rlService));

		return { stub, sentryLog, sfLog };
	}

	it("happy path: increment flows through all transforms", async () => {
		const { stub, sentryLog, sfLog } = buildStub();

		const result = await stub.increment(5);

		expect(result).toBe(5);
		expect(sentryLog).toHaveLength(0);
		expect(sfLog).toHaveLength(0);
	});

	it("errorBoundary converts a known network error to Result.err", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub } = buildStub({ sentryLog });

		const result = await stub.failWithNetwork();

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toMatchObject({
				message: expect.stringContaining("ECONNREFUSED"),
			});
		}

		// Known error — NOT sent to Sentry
		expect(sentryLog).toHaveLength(0);
	});

	it("errorBoundary converts a known timeout error to Result.err", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub } = buildStub({ sentryLog });

		const result = await stub.failWithTimeout();

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toMatchObject({
				message: expect.stringContaining("ETIMEDOUT"),
			});
		}

		expect(sentryLog).toHaveLength(0);
	});

	it("errorBoundary sends unknown errors to Sentry and wraps them", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub } = buildStub({ sentryLog });

		const result = await stub.failWithUnknown();

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toMatchObject({
				message: expect.stringContaining("something completely unexpected"),
			});
		}

		// Unknown error — sent to Sentry
		expect(sentryLog).toHaveLength(1);
		expect(sentryLog[0]!.method).toBe("failWithUnknown");
	});

	it("rateLimiter blocks increment when service denies", async () => {
		let checkCount = 0;
		const denyAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: false };
			},
		};
		const { stub } = buildStub({ rlService: denyAll });

		const result = await stub.increment(1);

		expect(typeof result).not.toBe("number");
		if (typeof result !== "number") {
			expect(Result.isError(result)).toBe(true);
			if (Result.isError(result)) {
				expect(result.error).toMatchObject({
					message: expect.stringContaining("Rate limit"),
				});
			}
		}
		expect(checkCount).toBe(1);
	});

	it("rateLimiter only applies to increment — other methods pass through", async () => {
		let checkCount = 0;
		const denyAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: false };
			},
		};
		const { stub } = buildStub({ rlService: denyAll });

		// failWithNetwork is not rate-limited, errorBoundary catches the throw
		const result = await stub.failWithNetwork();
		expect(Result.isError(result)).toBe(true);
		// Service was never called for failWithNetwork
		expect(checkCount).toBe(0);
	});

	it("rateLimiter allows increment when service approves", async () => {
		let checkCount = 0;
		const allowAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: true };
			},
		};
		const { stub } = buildStub({ rlService: allowAll });

		const result = await stub.increment(3);

		expect(result).toBe(3);
		expect(checkCount).toBe(1);
	});

	it("full scenario: known error + sentry empty + no singleFlight log", async () => {
		const sentryLog: SentryReport[] = [];
		const sfLog: SingleFlightMetricEntry[] = [];
		const { stub } = buildStub({ sentryLog, sfLog });

		// Successful call
		const r1 = await stub.increment(10);
		expect(r1).toBe(10);

		// Known error
		const r2 = await stub.failWithTimeout();
		expect(Result.isError(r2)).toBe(true);

		// Unknown error
		const r3 = await stub.failWithUnknown();
		expect(Result.isError(r3)).toBe(true);

		// Sentry only has the unknown error
		expect(sentryLog).toHaveLength(1);
		expect(sentryLog[0]!.method).toBe("failWithUnknown");

		// No singleFlight rejections (all sequential)
		expect(sfLog).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// errorMetrics: codec → errorBoundary → errorMetrics
//
// Exercises the pattern where:
//   1. A stub throws a raw Error
//   2. errorBoundary catches it and classifies into Result.err(KnownError)
//      or Result.err(UnknownRpcError)
//   3. errorMetrics (outermost) inspects the Result and emits a metric
//      label based on the classified error type
//
// Pipeline registration order:
//   .with(errorMetrics(log)).with(errorBoundary(sentryLog))
//
// Call flow:  errorMetrics → errorBoundary → stub (throws)
// Return flow: stub throws → errorBoundary classifies → errorMetrics logs
// ---------------------------------------------------------------------------

type ErrorMetricEntry = {
	method: string;
	label:
		| "rpc_ok"
		| "rpc_error_network"
		| "rpc_error_timeout"
		| "rpc_error_unknown";
	durationMs: number;
};

function isResultLike(value: unknown): value is Result<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		((value as Record<string, unknown>).status === "ok" ||
			(value as Record<string, unknown>).status === "error")
	);
}

/**
 * Caller-only transform that inspects the return value after
 * errorBoundary has already classified thrown errors into
 * Result.err(NetworkError | TimeoutError | UnknownRpcError).
 */
const errorMetrics = createTransform<PipelineStub>().caller(
	(log: ErrorMetricEntry[]) =>
		async ({ method, next }) => {
			const start = performance.now();
			const value = await next();
			const durationMs = performance.now() - start;

			if (isResultLike(value) && Result.isError(value)) {
				const err = value.error;
				let label: ErrorMetricEntry["label"];

				if (err instanceof NetworkError) {
					label = "rpc_error_network";
				} else if (err instanceof TimeoutError) {
					label = "rpc_error_timeout";
				} else {
					label = "rpc_error_unknown";
				}

				log.push({ method, label, durationMs });
			} else {
				log.push({ method, label: "rpc_ok", durationMs });
			}

			return value;
		}
);

describe("errorMetrics: codec → errorBoundary → errorMetrics", () => {
	function buildStub(overrides?: { sentryLog?: SentryReport[] }) {
		const sentryLog = overrides?.sentryLog ?? [];
		const metricsLog: ErrorMetricEntry[] = [];

		const ns = withTransforms(mockNamespace(() => createPipelineStub()));
		const id = ns.idFromName("err-metrics");

		// Registration order: errorMetrics (outermost) → errorBoundary (inner)
		// Return-path: errorBoundary classifies first, errorMetrics reads the Result
		const stub = ns
			.get(id)
			.with(errorMetrics(metricsLog))
			.with(errorBoundary(sentryLog));

		return { stub, metricsLog, sentryLog };
	}

	it("happy path: success emits rpc_ok", async () => {
		const { stub, metricsLog, sentryLog } = buildStub();

		const result = await stub.increment(5);

		expect(result).toBe(5);
		expect(metricsLog).toHaveLength(1);
		expect(metricsLog[0]).toMatchObject({
			method: "increment",
			label: "rpc_ok",
		});
		expect(sentryLog).toHaveLength(0);
	});

	it("known network error: errorBoundary classifies, metrics emits rpc_error_network", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub, metricsLog } = buildStub({ sentryLog });

		const result = await stub.failWithNetwork();

		// errorBoundary converted the throw to Result.err(NetworkError)
		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toBeInstanceOf(NetworkError);
		}

		// errorMetrics saw the classified error and logged the right label
		expect(metricsLog).toHaveLength(1);
		expect(metricsLog[0]).toMatchObject({
			method: "failWithNetwork",
			label: "rpc_error_network",
		});

		// Known error — NOT sent to Sentry
		expect(sentryLog).toHaveLength(0);
	});

	it("known timeout error: errorBoundary classifies, metrics emits rpc_error_timeout", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub, metricsLog } = buildStub({ sentryLog });

		const result = await stub.failWithTimeout();

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toBeInstanceOf(TimeoutError);
		}

		expect(metricsLog).toHaveLength(1);
		expect(metricsLog[0]).toMatchObject({
			method: "failWithTimeout",
			label: "rpc_error_timeout",
		});

		expect(sentryLog).toHaveLength(0);
	});

	it("unknown error: errorBoundary wraps, Sentry logs, metrics emits rpc_error_unknown", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub, metricsLog } = buildStub({ sentryLog });

		const result = await stub.failWithUnknown();

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toBeInstanceOf(UnknownRpcError);
		}

		expect(metricsLog).toHaveLength(1);
		expect(metricsLog[0]).toMatchObject({
			method: "failWithUnknown",
			label: "rpc_error_unknown",
		});

		// Unknown error — sent to Sentry
		expect(sentryLog).toHaveLength(1);
		expect(sentryLog[0]!.method).toBe("failWithUnknown");
	});

	it("mixed calls: each gets the correct metric label", async () => {
		const sentryLog: SentryReport[] = [];
		const { stub, metricsLog } = buildStub({ sentryLog });

		await stub.increment(1);
		await stub.failWithNetwork();
		await stub.failWithTimeout();
		await stub.failWithUnknown();
		await stub.increment(2);

		expect(metricsLog).toHaveLength(5);
		expect(metricsLog.map((m) => m.label)).toEqual([
			"rpc_ok",
			"rpc_error_network",
			"rpc_error_timeout",
			"rpc_error_unknown",
			"rpc_ok",
		]);
		expect(metricsLog.map((m) => m.method)).toEqual([
			"increment",
			"failWithNetwork",
			"failWithTimeout",
			"failWithUnknown",
			"increment",
		]);

		// Only the unknown error hit Sentry
		expect(sentryLog).toHaveLength(1);
	});

	it("durationMs is recorded for every call", async () => {
		const { stub, metricsLog } = buildStub();

		await stub.increment(1);
		await stub.failWithNetwork();

		expect(metricsLog).toHaveLength(2);
		for (const entry of metricsLog) {
			expect(entry.durationMs).toBeGreaterThanOrEqual(0);
			expect(typeof entry.durationMs).toBe("number");
		}
	});
});
