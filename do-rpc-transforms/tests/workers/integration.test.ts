/**
 * Integration tests using real Durable Objects via vitest-pool-workers.
 *
 * These tests run inside the workerd runtime with real DO stubs,
 * verifying that transforms work correctly over actual RPC boundaries.
 *
 * Callee-side transforms are verified by observing their effect on
 * return values (e.g. a "doubling" transform) since module-level
 * variables are not shared between the test module and the DO module
 * in workerd.
 */
import { Result } from "better-result";
import { env } from "cloudflare:test";
import { describe, it } from "vitest";
import { createTransform, withTransforms } from "../../src";
// ---------------------------------------------------------------------------
// Multi-DO shared transforms example
//
// Two DOs share the same reusable transforms but compose them differently:
//
//   InventoryDO (raw returns):
//     caller: throttle → tenantContext → [wire]
//     callee: featureGate → featureCheck → method
//
//   OrderDO (Result returns + codec):
//     caller: throttle → tenantContext → codec → [wire]
//     callee: featureCheck → codec → method
//
// OrderDO skips featureGate (the context appender).  featureCheck
// handles both cases — with cached features from featureGate or by
// fetching them directly using tenantId.
//
// Both DOs use the same throttle and tenantContext transforms,
// demonstrating reusability across different return conventions.
// ---------------------------------------------------------------------------

import { tenantContext, throttle } from "./src/example-transforms";
import { codec, metrics, rateLimiter, singleFlight } from "./src/transforms";
import type {
	FeatureDisabledResponse,
	MissingTenantResponse,
	ThrottledResponse,
} from "./src/example-transforms";
import type {
	MethodBusyError,
	MetricLogEntry,
	RateLimitService,
	SingleFlightMetricEntry,
} from "./src/transforms";

/** Type guard to narrow out ThrottledResponse from the union. */
function isThrottled(value: unknown): value is ThrottledResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"success" in value &&
		(value as ThrottledResponse).success === false
	);
}

// ---------------------------------------------------------------------------
// Caller-side transforms via namespace proxy
// ---------------------------------------------------------------------------

describe("caller transforms via namespace proxy", () => {
	it("wraps a real DO namespace and intercepts RPC calls", async ({
		expect,
	}) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();

		const events: string[] = [];
		const stub = ns.get(id).with(async ({ method, next }) => {
			events.push(`before:${method}`);
			const result = await next();
			events.push(`after:${method}`);
			return result;
		});

		// Inline passthrough handler widens the return type to the
		// union of all method returns (number | unknown[]).
		// Type assertion: NOT number — the inline overload produces the union.
		const result = await stub.increment(5);
		const _typeCheck: number | unknown[] = result;

		expect(result).toBe(5);
		expect(events).toEqual(["before:increment", "after:increment"]);
	});

	it("chains multiple caller transforms on a real stub", async ({ expect }) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();

		const events: string[] = [];

		const stub = ns
			.get(id)
			.with(async ({ method, next }) => {
				events.push(`first:${method}`);
				return next();
			})
			.with(async ({ method, next }) => {
				events.push(`second:${method}`);
				return next();
			});

		const result = await stub.increment(3);

		expect(result).toBe(3);
		expect(events).toEqual(["first:increment", "second:increment"]);
	});

	it("retry transform works over real RPC", async ({ expect }) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();

		let callCount = 0;
		const stub = ns.get(id).with(async ({ next }) => {
			callCount++;
			return next();
		});

		const result = await stub.increment(10);

		expect(result).toBe(10);
		expect(callCount).toBe(1);
	});

	it("unwrap returns the raw DO stub", async ({ expect }) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();
		const stub = ns.get(id);

		const raw = stub.unwrap();
		const result = await raw.increment(1);
		// Unwrapped raw stub preserves original per-method types
		const _typeCheck: number = result;
		expect(result).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Callee transforms on real DOs (via decorators)
//
// TransformedCounterDO has a callee transform that doubles numeric
// return values, so we can verify the transform ran by checking the
// return value across the RPC boundary.
// ---------------------------------------------------------------------------

describe("callee transforms on real DOs (class decorators)", () => {
	it("callee transforms modify return values across RPC", async ({
		expect,
	}) => {
		const id = env.TRANSFORMED_COUNTER.newUniqueId();
		const stub = env.TRANSFORMED_COUNTER.get(id);

		// Without transform, increment(7) would return 7.
		// The doubling transform makes it return 14.
		const result = await stub.increment(7);
		expect(result).toBe(14);
	});

	it("callee transforms apply to every method call", async ({ expect }) => {
		const id = env.TRANSFORMED_COUNTER.newUniqueId();
		const stub = env.TRANSFORMED_COUNTER.get(id);

		const r1 = await stub.increment(1); // count=1, doubled → 2
		const r2 = await stub.increment(2); // count=3, doubled → 6
		const r3 = await stub.getCount(); // count=3, doubled → 6

		expect(r1).toBe(2);
		expect(r2).toBe(6);
		expect(r3).toBe(6);
	});

	it("private fields (#count) work through callee transforms", async ({
		expect,
	}) => {
		const id = env.TRANSFORMED_COUNTER.newUniqueId();
		const stub = env.TRANSFORMED_COUNTER.get(id);

		await stub.increment(5); // count=5, doubled �� 10
		await stub.increment(3); // count=8, doubled → 16
		const count = await stub.getCount(); // count=8, doubled → 16

		expect(count).toBe(16);
	});
});

// ---------------------------------------------------------------------------
// Caller + callee full pipeline over real RPC
// ---------------------------------------------------------------------------

describe("full pipeline: caller + callee over real RPC", () => {
	it("caller and callee transforms both execute on a single call", async ({
		expect,
	}) => {
		const ns = withTransforms(env.TRANSFORMED_COUNTER);
		const id = ns.newUniqueId();

		const callerEvents: string[] = [];
		const stub = ns.get(id).with(async ({ method, next }) => {
			callerEvents.push(`caller:before:${method}`);
			const result = await next();
			callerEvents.push(`caller:after:${method}`);
			return result;
		});

		// Callee doubles, so increment(5) → count=5 → doubled → 10
		const result = await stub.increment(5);

		expect(result).toBe(10);
		expect(callerEvents).toEqual([
			"caller:before:increment",
			"caller:after:increment",
		]);
	});
});

// ---------------------------------------------------------------------------
// Inline bare handler .with()
// ---------------------------------------------------------------------------

describe("inline .with() on real stubs", () => {
	it("accepts a bare async function as transform", async ({ expect }) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();

		const events: string[] = [];
		const stub = ns.get(id).with(async ({ method, next }) => {
			events.push(`inline:${method}`);
			return next();
		});

		const result = await stub.increment(2);

		expect(result).toBe(2);
		expect(events).toEqual(["inline:increment"]);
	});
});

// ---------------------------------------------------------------------------
// Namespace proxy on real DurableObjectNamespace
// ---------------------------------------------------------------------------

describe("namespace proxy on real DurableObjectNamespace", () => {
	it("withTransforms(env.COUNTER) returns a namespace proxy", ({ expect }) => {
		const ns = withTransforms(env.COUNTER);

		expect(typeof ns.get).toBe("function");
		expect(typeof ns.idFromName).toBe("function");
		expect(typeof ns.idFromString).toBe("function");
		expect(typeof ns.newUniqueId).toBe("function");
	});

	it(".get(id) returns a stub with .with() chaining", async ({ expect }) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();
		const stub = ns.get(id);

		// Should have .with() and .unwrap()
		expect(typeof stub.with).toBe("function");
		expect(typeof stub.unwrap).toBe("function");

		// No transforms → original per-method types preserved
		const result = await stub.increment(5);
		const _typeCheck: number = result;
		expect(result).toBe(5);
	});

	it(".get(id).with(transform) applies caller transforms over real RPC", async ({
		expect,
	}) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.idFromName("ns-proxy-test-1");

		const events: string[] = [];

		const stub = ns.get(id).with(async ({ method, next }) => {
			events.push(`before:${method}`);
			const result = await next();
			events.push(`after:${method}`);
			return result;
		});
		const result = await stub.increment(3);

		expect(result).toBe(3);
		expect(events).toEqual(["before:increment", "after:increment"]);
	});

	it("chains multiple transforms on namespace-produced stubs", async ({
		expect,
	}) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();

		const events: string[] = [];

		const stub = ns
			.get(id)
			.with(async ({ method, next }) => {
				events.push(`first:${method}`);
				return next();
			})
			.with(async ({ method, next }) => {
				events.push(`second:${method}`);
				return next();
			});

		const result = await stub.increment(7);

		expect(result).toBe(7);
		expect(events).toEqual(["first:increment", "second:increment"]);
	});

	it("namespace proxy + callee transforms (TransformedCounterDO)", async ({
		expect,
	}) => {
		const ns = withTransforms(env.TRANSFORMED_COUNTER);
		const id = ns.newUniqueId();

		const callerEvents: string[] = [];
		const stub = ns.get(id).with(async ({ method, next }) => {
			callerEvents.push(`caller:${method}`);
			return next();
		});

		// Callee doubles the result, so increment(4) → count=4 → doubled → 8
		const result = await stub.increment(4);

		expect(result).toBe(8);
		expect(callerEvents).toEqual(["caller:increment"]);
	});

	it("idFromName / idFromString still work through the proxy", ({ expect }) => {
		const ns = withTransforms(env.COUNTER);

		const id1 = ns.idFromName("test-name");
		expect(id1.toString()).toBeTruthy();

		const id2 = ns.idFromString(id1.toString());
		expect(id2.toString()).toBe(id1.toString());
	});

	it(".unwrap() on namespace-produced stub returns the raw DO stub", async ({
		expect,
	}) => {
		const ns = withTransforms(env.COUNTER);
		const id = ns.newUniqueId();
		const stub = ns.get(id);

		const raw = stub.unwrap();

		// Raw stub should still work for RPC
		const result = await raw.increment(10);
		expect(result).toBe(10);
	});
});

describe("better-result bridge over real RPC", () => {
	it("round-trips a Result.ok through the bridge", async ({ expect }) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(codec());

		const result = await stub.createItem("Widget");

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toEqual({ id: "item-1", title: "Widget" });
		}
	});

	it("round-trips a Result.err through the bridge", async ({ expect }) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(codec());

		// Empty title triggers ValidationError
		const result = await stub.createItem("");

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			// After deserialization the error retains its message;
			// _tag may or may not survive the wire depending on the
			// better-result version and serialization format.
			expect(result.error).toMatchObject({
				message: "title is required",
			});
		}
	});

	it("passes through non-Result values unchanged", async ({ expect }) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(codec());

		// plainMethod returns a raw string, not a Result
		const result = await stub.plainMethod();
		expect(result).toBe("not a Result");
	});

	it("callee serialization is visible without caller codec", async ({
		expect,
	}) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id); // no caller codec

		// Without the caller codec, we see the serialized wire format
		const raw = await stub.createItem("Visible");
		expect(raw).toMatchObject({
			status: "ok",
			value: { id: "item-1", title: "Visible" },
		});
	});

	it("works with chained caller transforms (codec + named tracing)", async ({
		expect,
	}) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();

		const events: string[] = [];
		// Named transform preserves per-method return types (passthrough).
		// Inline handlers widen to the union of all method returns, so
		// we use a named transform here to keep Result types precise.
		const trace = createTransform<object>().caller(
			() =>
				async ({ method, next }) => {
					events.push(`trace:${method}`);
					return next();
				}
		)();

		const stub = ns.get(id).with(codec()).with(trace);

		const result = await stub.createItem("Traced");

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toEqual({ id: "item-1", title: "Traced" });
		}
		expect(events).toEqual(["trace:createItem"]);
	});

	it("getItem returns Result.err for missing items", async ({ expect }) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(codec());

		const result = await stub.getItem("nonexistent");

		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toMatchObject({
				message: "item nonexistent not found",
			});
		}
	});

	it("create then get round-trips through the bridge", async ({ expect }) => {
		const ns = withTransforms(env.RESULT_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(codec());

		const created = await stub.createItem("Roundtrip");
		expect(Result.isOk(created)).toBe(true);

		if (Result.isOk(created)) {
			const fetched = await stub.getItem(created.value.id);
			expect(Result.isOk(fetched)).toBe(true);
			if (Result.isOk(fetched)) {
				expect(fetched.value).toEqual(created.value);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// metrics + codec over real RPC
//
// Transforms are defined in ./src/transforms.ts and shared between this
// test (caller side) and the worker entry (callee side).
//
// Full pipeline per call:
//   caller: metrics(accountId) → codec → [wire]
//   callee: metrics → codec → method
//
// The caller injects accountId via context.  The callee reads
// it and records a metric entry that includes the method result.
// ---------------------------------------------------------------------------

describe("metrics + codec over real RPC", () => {
	it("callee logs accountId from caller context and the method result", async ({
		expect,
	}) => {
		const ns = withTransforms(env.METRICS_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(metrics("acct-42")).with(codec());

		const result = await stub.createItem("Widget");

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toEqual({ id: "item-1", title: "Widget" });
		}

		// Callee metrics include accountId + result
		const log = await stub.getMetrics();
		// 2 entries: createItem + getMetrics itself
		expect(log).toHaveLength(2);
		const entry = log[0] as MetricLogEntry;
		expect(entry.method).toBe("createItem");
		expect(entry.accountId).toBe("acct-42");
		expect(entry.status).toBe("ok");
		expect(entry.durationMs).toBeGreaterThanOrEqual(0);
		// result is the raw Result value (before codec serialization)
		expect(Result.isOk(entry.result as never)).toBe(true);
	});

	it("callee logs error result with accountId", async ({ expect }) => {
		const ns = withTransforms(env.METRICS_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(metrics("acct-99")).with(codec());

		const result = await stub.createItem("");

		expect(Result.isError(result)).toBe(true);

		const log = await stub.getMetrics();
		const entry = log[0] as MetricLogEntry;
		expect(entry.method).toBe("createItem");
		expect(entry.accountId).toBe("acct-99");
		expect(entry.status).toBe("error");
		expect(Result.isError(entry.result as never)).toBe(true);
	});

	it("distinct accountIds on different calls", async ({ expect }) => {
		const ns = withTransforms(env.METRICS_DO);
		const id = ns.newUniqueId();

		await ns.get(id).with(metrics("acct-A")).with(codec()).createItem("One");
		await ns.get(id).with(metrics("acct-B")).with(codec()).createItem("Two");
		await ns
			.get(id)
			.with(metrics("acct-C"))
			.with(codec())
			.getItem("nonexistent");

		const log = await ns
			.get(id)
			.with(metrics("acct-check"))
			.with(codec())
			.getMetrics();

		// 4 entries: createItem, createItem, getItem, getMetrics
		expect(log).toHaveLength(4);
		expect(log[0]).toMatchObject({
			method: "createItem",
			status: "ok",
			accountId: "acct-A",
		});
		expect(log[1]).toMatchObject({
			method: "createItem",
			status: "ok",
			accountId: "acct-B",
		});
		expect(log[2]).toMatchObject({
			method: "getItem",
			status: "error",
			accountId: "acct-C",
		});
		expect(log[3]).toMatchObject({
			method: "getMetrics",
			accountId: "acct-check",
		});
	});

	it("no accountId when metrics transform is not used", async ({ expect }) => {
		const ns = withTransforms(env.METRICS_DO);
		const id = ns.newUniqueId();

		// Only codec, no metrics — callee still runs its metrics transform
		// but context will be empty
		const stub = ns.get(id).with(codec());
		await stub.createItem("NoAccount");

		const log = await stub.getMetrics();
		const entry = log[0] as MetricLogEntry;
		expect(entry.method).toBe("createItem");
		expect(entry.status).toBe("ok");
		expect(entry.accountId).toBeUndefined();
	});

	it("full round-trip: create → get, callee records both results", async ({
		expect,
	}) => {
		const ns = withTransforms(env.METRICS_DO);
		const id = ns.newUniqueId();
		const stub = ns.get(id).with(metrics("acct-rt")).with(codec());

		const created = await stub.createItem("Roundtrip");
		expect(Result.isOk(created)).toBe(true);

		if (Result.isOk(created)) {
			const fetched = await stub.getItem(created.value.id);
			expect(Result.isOk(fetched)).toBe(true);
			if (Result.isOk(fetched)) {
				expect(fetched.value).toEqual(created.value);
			}
		}

		const log = await stub.getMetrics();
		// 3 entries: createItem, getItem, getMetrics
		expect(log).toHaveLength(3);
		expect(log[0]).toMatchObject({
			method: "createItem",
			status: "ok",
			accountId: "acct-rt",
		});
		// The callee result for createItem is the raw Result.ok
		expect(Result.isOk(log[0]?.result as never)).toBe(true);

		expect(log[1]).toMatchObject({
			method: "getItem",
			status: "ok",
			accountId: "acct-rt",
		});
		expect(Result.isOk(log[1]?.result as never)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// singleFlight over real RPC
//
// The singleFlight transform ensures only one invocation of a given
// method runs at a time on a DO instance.  Concurrent calls to the
// same method return Result.err(MethodBusyError).  The caller side
// detects this and logs a metric.
//
// Pipeline:
//   caller: singleFlight(log) → codec → [wire]
//   callee: codec → singleFlight → method
// ---------------------------------------------------------------------------

describe("singleFlight over real RPC", () => {
	it("allows a single call to complete successfully", async ({ expect }) => {
		const ns = withTransforms(env.SINGLE_FLIGHT_DO);
		const id = ns.newUniqueId();
		const log: SingleFlightMetricEntry[] = [];
		const stub = ns.get(id).with(singleFlight(log)).with(codec());

		const result = await stub.increment(5);
		// singleFlight's AddBusyError OutputFn widens the error channel:
		//   increment: Result<number, never> → Result<number, MethodBusyError>
		const _typeCheck: Result<number, MethodBusyError> = result;

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toBe(5);
		}
		expect(log).toHaveLength(0);
	});

	it("rejects concurrent calls to the same method with MethodBusyError", async ({
		expect,
	}) => {
		const ns = withTransforms(env.SINGLE_FLIGHT_DO);
		const id = ns.newUniqueId();
		const log: SingleFlightMetricEntry[] = [];
		const stub = ns.get(id).with(singleFlight(log)).with(codec());

		// Fire two concurrent slowIncrement calls.
		// The first takes 100ms, so the second should arrive while it's running.
		const [first, second] = await Promise.all([
			stub.slowIncrement(10, 100),
			stub.slowIncrement(5, 100),
		]);

		// One succeeds, one is rejected as busy
		const results = [first, second];
		const successes = results.filter((r) => Result.isOk(r));
		const errors = results.filter((r) => Result.isError(r));

		expect(successes).toHaveLength(1);
		expect(errors).toHaveLength(1);

		if (Result.isOk(successes[0]!)) {
			expect(successes[0]!.value).toBe(10);
		}

		if (Result.isError(errors[0]!)) {
			expect(errors[0]!.error).toMatchObject({
				message: expect.stringContaining("slowIncrement"),
			});
		}

		// Caller logged the busy metric
		expect(log).toHaveLength(1);
		expect(log[0]).toEqual({ method: "slowIncrement", status: "busy" });
	});

	it("allows different methods to run concurrently", async ({ expect }) => {
		const ns = withTransforms(env.SINGLE_FLIGHT_DO);
		const id = ns.newUniqueId();
		const log: SingleFlightMetricEntry[] = [];
		const stub = ns.get(id).with(singleFlight(log)).with(codec());

		// slowIncrement and getCount are different methods — both should succeed
		const [incResult, countResult] = await Promise.all([
			stub.slowIncrement(7, 50),
			stub.getCount(),
		]);

		expect(Result.isOk(incResult)).toBe(true);
		expect(Result.isOk(countResult)).toBe(true);

		// No busy rejections
		expect(log).toHaveLength(0);
	});

	it("releases the lock after a call completes so the next call succeeds", async ({
		expect,
	}) => {
		const ns = withTransforms(env.SINGLE_FLIGHT_DO);
		const id = ns.newUniqueId();
		const log: SingleFlightMetricEntry[] = [];
		const stub = ns.get(id).with(singleFlight(log)).with(codec());

		// First call completes
		const r1 = await stub.slowIncrement(3, 10);
		expect(Result.isOk(r1)).toBe(true);

		// Second call should also succeed — lock was released
		const r2 = await stub.slowIncrement(4, 10);
		expect(Result.isOk(r2)).toBe(true);

		if (Result.isOk(r2)) {
			expect(r2.value).toBe(7); // 3 + 4
		}

		expect(log).toHaveLength(0);
	});

	it("caller does not log a metric for successful calls", async ({
		expect,
	}) => {
		const ns = withTransforms(env.SINGLE_FLIGHT_DO);
		const id = ns.newUniqueId();
		const log: SingleFlightMetricEntry[] = [];
		const stub = ns.get(id).with(singleFlight(log)).with(codec());

		await stub.increment(1);
		await stub.increment(2);
		await stub.getCount();

		expect(log).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Full pipeline over real RPC
//
// Exercises the complete transform stack on a single DO:
//
//   Caller: singleFlight → rateLimiter("increment") → metrics → codec
//   Callee: singleFlight → metrics → codec → method
//
// errorBoundary (caller-only, catches thrown errors) is tested in the
// unit tests with mock stubs — vitest-pool-workers' isolated storage
// does not tolerate uncaught DO exceptions.
// ---------------------------------------------------------------------------

describe("full pipeline over real RPC", () => {
	function createStub(overrides?: {
		singleFlightLog?: SingleFlightMetricEntry[];
		rateLimitService?: RateLimitService;
		accountId?: string;
	}) {
		const sfLog = overrides?.singleFlightLog ?? [];
		const accountId = overrides?.accountId ?? "acct-full";

		const allowAll: RateLimitService = {
			async check() {
				return { allowed: true };
			},
		};
		const rlService = overrides?.rateLimitService ?? allowAll;

		const ns = withTransforms(env.FULL_PIPELINE_DO);
		const id = ns.newUniqueId();

		const stub = ns
			.get(id)
			.with(singleFlight(sfLog))
			.with(rateLimiter("increment", rlService))
			.with(metrics(accountId))
			.with(codec());

		return { stub, sfLog };
	}

	it("happy path: increment flows through all transforms", async ({
		expect,
	}) => {
		const { stub } = createStub();

		const result = await stub.increment(5);
		// Full pipeline: singleFlight(AddBusyError) → rateLimiter → metrics → codec
		// Only singleFlight declares an output (AddBusyError), the rest pass through.
		const _typeCheck: Result<number, MethodBusyError> = result;

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toBe(5);
		}

		// Callee metrics recorded the call
		const metricsLog = await stub.getMetrics();
		// 2 entries: increment + getMetrics itself
		expect(metricsLog).toHaveLength(2);
		expect(metricsLog[0]).toMatchObject({
			method: "increment",
			status: "ok",
			accountId: "acct-full",
		});
	});

	it("inline .with() next({ result }) overrides return type to string", async ({
		expect,
	}) => {
		const { stub } = createStub();

		// Inline override: next({ result: "blah" }) → all methods return string
		const result = await stub
			.with(({ next }) => next({ result: "blah" }))
			.increment(5);

		// Type should be string — not Result
		const _typeCheck: string = result;
		expect(result).toBe("blah");
	});

	it("singleFlight rejects concurrent slowIncrement calls", async ({
		expect,
	}) => {
		const sfLog: SingleFlightMetricEntry[] = [];
		const { stub } = createStub({ singleFlightLog: sfLog });

		const [first, second] = await Promise.all([
			stub.slowIncrement(10, 100),
			stub.slowIncrement(5, 100),
		]);

		const results = [first, second];
		const successes = results.filter((r) => Result.isOk(r));
		const errors = results.filter((r) => Result.isError(r));

		expect(successes).toHaveLength(1);
		expect(errors).toHaveLength(1);

		// singleFlight logged the busy rejection
		expect(sfLog).toHaveLength(1);
		expect(sfLog[0]).toEqual({ method: "slowIncrement", status: "busy" });
	});

	it("rateLimiter blocks increment when service denies", async ({ expect }) => {
		let checkCount = 0;
		const denyAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: false };
			},
		};
		const { stub } = createStub({ rateLimitService: denyAll });

		const result = await stub.increment(1);

		// Rate limited — should be a Result.err
		expect(Result.isError(result)).toBe(true);
		if (Result.isError(result)) {
			expect(result.error).toMatchObject({
				message: expect.stringContaining("Rate limit"),
			});
		}

		// The service was actually called
		expect(checkCount).toBe(1);
	});

	it("rateLimiter only scopes to increment — getCount passes through", async ({
		expect,
	}) => {
		let checkCount = 0;
		const denyAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: false };
			},
		};
		const { stub } = createStub({ rateLimitService: denyAll });

		// getCount is not rate-limited
		const result = await stub.getCount();

		expect(Result.isOk(result)).toBe(true);
		// Service was never called for getCount
		expect(checkCount).toBe(0);
	});

	it("rateLimiter allows increment when service approves", async ({
		expect,
	}) => {
		let checkCount = 0;
		const allowAll: RateLimitService = {
			async check() {
				checkCount++;
				return { allowed: true };
			},
		};
		const { stub } = createStub({ rateLimitService: allowAll });

		const result = await stub.increment(3);

		expect(Result.isOk(result)).toBe(true);
		if (Result.isOk(result)) {
			expect(result.value).toBe(3);
		}
		expect(checkCount).toBe(1);
	});

	it("callee metrics record entries across multiple call types", async ({
		expect,
	}) => {
		const { stub } = createStub({ accountId: "acct-metrics" });

		// Successful call
		await stub.increment(1);
		// Another successful call
		await stub.getCount();

		const metricsLog = await stub.getMetrics();
		// 3 entries: increment, getCount, getMetrics itself
		expect(metricsLog).toHaveLength(3);

		expect(metricsLog[0]).toMatchObject({
			method: "increment",
			status: "ok",
			accountId: "acct-metrics",
		});
		expect(metricsLog[1]).toMatchObject({
			method: "getCount",
			status: "ok",
			accountId: "acct-metrics",
		});
	});
});

describe("multi-DO shared transforms: InventoryDO (raw returns)", () => {
	function createInventoryStub(
		tenantId: string,
		throttleOpts?: { maxCalls: number; windowMs: number }
	) {
		const { maxCalls, windowMs } = throttleOpts ?? {
			maxCalls: 100,
			windowMs: 60_000,
		};

		const ns = withTransforms(env.INVENTORY_DO);
		const id = ns.newUniqueId();

		const stub = ns
			.get(id)
			.with(throttle(maxCalls, windowMs))
			.with(tenantContext(tenantId));

		return stub;
	}

	it("happy path: addStock succeeds for a tenant with 'inventory' feature", async ({
		expect,
	}) => {
		const stub = createInventoryStub("tenant-full");

		const result = await stub.addStock("SKU-001", 50);

		// InventoryDO returns raw numbers — throttle adds ThrottledResponse
		// to the union, so we narrow it out first
		const _typeCheck: number | ThrottledResponse = result;
		expect(typeof result).toBe("number");
		expect(result).toBe(50);
	});

	it("getStock returns 0 for unknown SKU", async ({ expect }) => {
		const stub = createInventoryStub("tenant-full");

		const result = await stub.getStock("nonexistent");

		const _typeCheck: number | ThrottledResponse = result;
		expect(result).toBe(0);
	});

	it("addStock accumulates across calls", async ({ expect }) => {
		const stub = createInventoryStub("tenant-full");

		await stub.addStock("SKU-A", 10);
		await stub.addStock("SKU-A", 25);
		const stock = await stub.getStock("SKU-A");

		expect(stock).toBe(35);
	});

	it("listSkus returns all known SKUs", async ({ expect }) => {
		const stub = createInventoryStub("tenant-full");

		await stub.addStock("WIDGET", 5);
		await stub.addStock("GADGET", 3);
		const skus = await stub.listSkus();

		const _typeCheck: string[] | ThrottledResponse = skus;
		expect(Array.isArray(skus)).toBe(true);
		if (Array.isArray(skus)) {
			expect(skus).toContain("WIDGET");
			expect(skus).toContain("GADGET");
		}
	});

	it("featureCheck blocks when tenant lacks 'inventory' feature", async ({
		expect,
	}) => {
		// tenant-orders-only has ["orders"] but not "inventory"
		const stub = createInventoryStub("tenant-orders-only");

		const result = await stub.addStock("SKU-001", 10);

		// The callee short-circuits with FeatureDisabledResponse.
		// Because it's a raw-return DO, the response comes back as a
		// plain object (not a Result).
		const response = result as unknown as FeatureDisabledResponse;
		expect(response.tag).toBe("FeatureDisabledResponse");
		expect(response.feature).toBe("inventory");
		expect(response.method).toBe("addStock");
	});

	it("featureGate blocks when tenantId is missing", async ({ expect }) => {
		// Empty tenantId — featureGate sees no tenantId in context
		const ns = withTransforms(env.INVENTORY_DO);
		const id = ns.newUniqueId();

		// No tenantContext transform → context has no tenantId
		const stub = ns.get(id);

		const result = await stub.addStock("SKU-001", 10);

		const response = result as unknown as MissingTenantResponse;
		expect(response.tag).toBe("MissingTenantResponse");
		expect(response.method).toBe("addStock");
	});

	it("tenant-none gets blocked by featureCheck", async ({ expect }) => {
		const stub = createInventoryStub("tenant-none");

		const result = await stub.getStock("SKU-001");

		const response = result as unknown as FeatureDisabledResponse;
		expect(response.tag).toBe("FeatureDisabledResponse");
		expect(response.feature).toBe("inventory");
	});

	it("throttle blocks when rate limit is exceeded", async ({ expect }) => {
		// Allow only 2 calls per 10-second window
		const stub = createInventoryStub("tenant-full", {
			maxCalls: 2,
			windowMs: 10_000,
		});

		// First two calls should succeed
		const r1 = await stub.addStock("SKU-001", 1);
		expect(isThrottled(r1)).toBe(false);
		expect(r1).toBe(1);

		const r2 = await stub.addStock("SKU-001", 1);
		expect(isThrottled(r2)).toBe(false);
		expect(r2).toBe(2);

		// Third call should be throttled — short-circuits before the wire
		const r3 = await stub.addStock("SKU-001", 1);

		// Type system surfaces ThrottledResponse in the union — no cast needed
		expect(isThrottled(r3)).toBe(true);
		if (isThrottled(r3)) {
			expect(r3.success).toBe(false);
			expect(r3.message).toContain("addStock");
		}
	});

	it("featureGate appends enabledFeatures that featureCheck reads", async ({
		expect,
	}) => {
		// tenant-inventory-only has ["inventory"] — passes featureCheck
		const stub = createInventoryStub("tenant-inventory-only");

		// featureGate fetches features and appends them to context.
		// featureCheck reads the cached features — no second fetch needed.
		const result = await stub.addStock("SKU-001", 100);

		expect(isThrottled(result)).toBe(false);
		expect(result).toBe(100);
	});
});

describe("multi-DO shared transforms: OrderDO (Result returns + codec)", () => {
	function createOrderStub(
		tenantId: string,
		throttleOpts?: { maxCalls: number; windowMs: number }
	) {
		const { maxCalls, windowMs } = throttleOpts ?? {
			maxCalls: 100,
			windowMs: 60_000,
		};

		const ns = withTransforms(env.ORDER_DO);
		const id = ns.newUniqueId();

		const stub = ns
			.get(id)
			.with(throttle(maxCalls, windowMs))
			.with(tenantContext(tenantId))
			.with(codec());

		return stub;
	}

	it("happy path: placeOrder succeeds for a tenant with 'orders' feature", async ({
		expect,
	}) => {
		const stub = createOrderStub("tenant-full");

		const result = await stub.placeOrder("WIDGET", 5);

		// OrderDO returns Result — throttle adds ThrottledResponse to the union.
		// Narrow it out before using Result methods.
		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isOk(result)).toBe(true);
			if (Result.isOk(result)) {
				expect(result.value).toMatchObject({ sku: "WIDGET", qty: 5 });
				expect(result.value.id).toBe("order-1");
			}
		}
	});

	it("placeOrder returns Result.err for invalid input", async ({ expect }) => {
		const stub = createOrderStub("tenant-full");

		// Empty SKU triggers ValidationError
		const result = await stub.placeOrder("", 1);

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isError(result)).toBe(true);
			if (Result.isError(result)) {
				expect(result.error).toMatchObject({
					message: "sku is required",
				});
			}
		}
	});

	it("placeOrder returns Result.err for non-positive qty", async ({
		expect,
	}) => {
		const stub = createOrderStub("tenant-full");

		const result = await stub.placeOrder("WIDGET", 0);

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isError(result)).toBe(true);
			if (Result.isError(result)) {
				expect(result.error).toMatchObject({
					message: "qty must be positive",
				});
			}
		}
	});

	it("getOrder round-trips through codec", async ({ expect }) => {
		const stub = createOrderStub("tenant-full");

		const placed = await stub.placeOrder("GADGET", 3);
		expect(isThrottled(placed)).toBe(false);
		if (!isThrottled(placed)) {
			expect(Result.isOk(placed)).toBe(true);

			if (Result.isOk(placed)) {
				const fetched = await stub.getOrder(placed.value.id);
				expect(isThrottled(fetched)).toBe(false);
				if (!isThrottled(fetched)) {
					expect(Result.isOk(fetched)).toBe(true);
					if (Result.isOk(fetched)) {
						expect(fetched.value).toEqual(placed.value);
					}
				}
			}
		}
	});

	it("getOrder returns Result.err for missing order", async ({ expect }) => {
		const stub = createOrderStub("tenant-full");

		const result = await stub.getOrder("nonexistent");

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isError(result)).toBe(true);
			if (Result.isError(result)) {
				expect(result.error).toMatchObject({
					message: "order nonexistent not found",
				});
			}
		}
	});

	it("listOrders returns all orders", async ({ expect }) => {
		const stub = createOrderStub("tenant-full");

		await stub.placeOrder("A", 1);
		await stub.placeOrder("B", 2);
		const result = await stub.listOrders();

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isOk(result)).toBe(true);
			if (Result.isOk(result)) {
				expect(result.value).toHaveLength(2);
				expect(result.value[0]).toMatchObject({ sku: "A", qty: 1 });
				expect(result.value[1]).toMatchObject({ sku: "B", qty: 2 });
			}
		}
	});

	it("featureCheck blocks when tenant lacks 'orders' feature", async ({
		expect,
	}) => {
		// tenant-inventory-only has ["inventory"] but not "orders"
		const stub = createOrderStub("tenant-inventory-only");

		const result = await stub.placeOrder("WIDGET", 1);

		// featureCheck short-circuits with FeatureDisabledResponse via
		// next({ result }).  The codec callee serializes it, and the
		// codec caller deserializes it.  The response is a plain object
		// — not a Result class — because featureCheck bypassed the method.
		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			const raw = result as unknown as Record<string, unknown>;
			expect(raw).toMatchObject({
				tag: "FeatureDisabledResponse",
				feature: "orders",
				method: "placeOrder",
			});
		}
	});

	it("featureCheck fetches features directly (no featureGate in pipeline)", async ({
		expect,
	}) => {
		// OrderDO has no featureGate — featureCheck fetches features
		// using tenantId from context.
		// tenant-orders-only has ["orders"] → should pass
		const stub = createOrderStub("tenant-orders-only");

		const result = await stub.placeOrder("WIDGET", 1);

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			expect(Result.isOk(result)).toBe(true);
			if (Result.isOk(result)) {
				expect(result.value).toMatchObject({ sku: "WIDGET", qty: 1 });
			}
		}
	});

	it("throttle blocks when rate limit is exceeded", async ({ expect }) => {
		// Allow only 1 call per 10-second window
		const stub = createOrderStub("tenant-full", {
			maxCalls: 1,
			windowMs: 10_000,
		});

		// First call succeeds
		const r1 = await stub.placeOrder("WIDGET", 1);
		expect(isThrottled(r1)).toBe(false);

		// Second call is throttled — returns { success: false, message }
		const r2 = await stub.placeOrder("GADGET", 2);

		expect(isThrottled(r2)).toBe(true);
		if (isThrottled(r2)) {
			expect(r2.success).toBe(false);
			expect(r2.message).toContain("placeOrder");
		}
	});

	it("tenant-none gets blocked by featureCheck", async ({ expect }) => {
		const stub = createOrderStub("tenant-none");

		const result = await stub.placeOrder("WIDGET", 1);

		expect(isThrottled(result)).toBe(false);
		if (!isThrottled(result)) {
			const raw = result as unknown as Record<string, unknown>;
			expect(raw).toMatchObject({
				tag: "FeatureDisabledResponse",
				feature: "orders",
			});
		}
	});
});

describe("multi-DO shared transforms: cross-DO context flow", () => {
	it("same tenantContext transform works for both DOs", async ({ expect }) => {
		// Verify that the same tenantContext("tenant-full") works
		// on both InventoryDO and OrderDO
		const inventoryNs = withTransforms(env.INVENTORY_DO);
		const orderNs = withTransforms(env.ORDER_DO);

		const inventoryStub = inventoryNs
			.get(inventoryNs.newUniqueId())
			.with(tenantContext("tenant-full"));

		const orderStub = orderNs
			.get(orderNs.newUniqueId())
			.with(tenantContext("tenant-full"))
			.with(codec());

		// Both should succeed — tenant-full has both features
		const invResult = await inventoryStub.addStock("SHARED-SKU", 10);
		expect(invResult).toBe(10);

		const orderResult = await orderStub.placeOrder("SHARED-SKU", 2);
		expect(Result.isOk(orderResult)).toBe(true);
		if (Result.isOk(orderResult)) {
			expect(orderResult.value).toMatchObject({
				sku: "SHARED-SKU",
				qty: 2,
			});
		}
	});

	it("same throttle transform instance is independent per .with() call", async ({
		expect,
	}) => {
		// Each .with(throttle(...)) creates its own closure with its own
		// timestamps array — exhausting one doesn't affect the other.
		const inventoryNs = withTransforms(env.INVENTORY_DO);
		const orderNs = withTransforms(env.ORDER_DO);

		const inventoryStub = inventoryNs
			.get(inventoryNs.newUniqueId())
			.with(throttle(1, 10_000))
			.with(tenantContext("tenant-full"));

		const orderStub = orderNs
			.get(orderNs.newUniqueId())
			.with(throttle(1, 10_000))
			.with(tenantContext("tenant-full"))
			.with(codec());

		// Exhaust inventory throttle
		await inventoryStub.addStock("SKU-1", 1);
		const invThrottled = await inventoryStub.addStock("SKU-1", 1);
		expect(isThrottled(invThrottled)).toBe(true);
		if (isThrottled(invThrottled)) {
			expect(invThrottled.success).toBe(false);
		}

		// Order throttle should still be fresh — not affected
		const orderResult = await orderStub.placeOrder("SKU-1", 1);
		expect(isThrottled(orderResult)).toBe(false);
		if (!isThrottled(orderResult)) {
			expect(Result.isOk(orderResult)).toBe(true);
		}
	});
});
