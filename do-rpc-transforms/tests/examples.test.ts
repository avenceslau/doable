/**
 * End-to-end example tests
 *
 * Each test exercises a realistic transform pattern from the PRD
 * against a fake DO stub/instance, verifying the full pipeline
 * from caller → callee → method → callee → caller.
 *
 * All examples use a single shared `AppDO` type — a Durable Object
 * with both plain methods and Result-returning methods — so that the
 * tests read like real-world usage of one service, many transforms.
 */
import { Result, TaggedError } from "better-result";
import { describe, expect, it, vi } from "vitest";
import { withCalleeTransforms, withTransforms } from "../src";
import { createAuthGuard, UnauthorizedError } from "./examples/auth-guard";
import {
	createBetterResultBridge,
	createBetterResultCalleeCodec,
	createBetterResultCallerCodec,
	createMetricsFromCodec,
	createMetricsWithBetterResult,
	RetryableNetworkError,
	UserInputError,
} from "./examples/better-result-bridge";
import {
	createContextObservabilityCallee,
	createContextObservabilityCaller,
	createFullObservability,
	createObservabilityCallee,
	createObservabilityCaller,
} from "./examples/observability";
import {
	createResultBridge,
	createResultCalleeCodec,
	createResultCallerCodec,
} from "./examples/result-bridge";
import { createRetry } from "./examples/retry";
import type { BetterResultMetricEntry } from "./examples/better-result-bridge";
import type { ContextMetricEntry, MetricEntry } from "./examples/observability";

// ---------------------------------------------------------------------------
// Shared DO type and factory
//
// A single Durable Object type used across all examples.  It has:
// - Plain methods (createTodo, listTodos, etc.) for retry/observability tests
// - Result-returning methods (createItem, failNetwork) for codec/metrics tests
// - A method that always throws for error-boundary testing
// ---------------------------------------------------------------------------

type Item = { id: string; title: string };

type AppError = RetryableNetworkError | UserInputError;

type AppDO = {
	id: string;
	items: Item[];

	// Plain methods (throw on transient failure)
	createTodo(title: string, token?: string): Promise<Item>;
	getTodo(id: string): Promise<Item | null>;
	listTodos(): Promise<Item[]>;
	deleteTodo(id: string): Promise<boolean>;
	failingMethod(): Promise<never>;

	// Result-returning methods
	createItem(title: string): Promise<Result<Item, UserInputError>>;
	failNetwork(): Promise<Result<never, RetryableNetworkError>>;
	plainMethod(): Promise<string>;
};

function createAppDO(options?: { failCount?: number }): AppDO {
	let failsRemaining = options?.failCount ?? 0;
	let nextId = 1;

	const obj: AppDO = {
		id: "app-do-1",
		items: [],

		// Plain methods
		async createTodo(title: string): Promise<Item> {
			if (failsRemaining > 0) {
				failsRemaining--;
				throw new Error("transient-error");
			}

			const item: Item = { id: `todo-${nextId++}`, title };
			obj.items.push(item);
			return item;
		},

		async getTodo(id: string): Promise<Item | null> {
			return obj.items.find((i) => i.id === id) ?? null;
		},

		async listTodos(): Promise<Item[]> {
			return [...obj.items];
		},

		async deleteTodo(id: string): Promise<boolean> {
			const idx = obj.items.findIndex((i) => i.id === id);
			if (idx === -1) {
				return false;
			}
			obj.items.splice(idx, 1);
			return true;
		},

		async failingMethod(): Promise<never> {
			const error = new Error("permanent-failure");
			(error as Error & { code?: string }).code = "EPERM";
			throw error;
		},

		// Result-returning methods
		async createItem(title: string) {
			if (!title || title.trim().length === 0) {
				return Result.err(new UserInputError({ message: "title is required" }));
			}
			return Result.ok({ id: `item-${nextId++}`, title });
		},

		async failNetwork() {
			return Result.err(
				new RetryableNetworkError({ message: "upstream timeout" })
			);
		},

		async plainMethod() {
			return "not a Result";
		},
	};

	return obj;
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

// ===========================================================================
// 1. Retry Transform
// ===========================================================================

describe("retry transform (e2e)", () => {
	it("retries transient failures and succeeds", async () => {
		const ns = withTransforms(
			mockNamespace(() => createAppDO({ failCount: 2 }))
		);
		const stub = ns.get("x").with(createRetry<AppDO>(3));

		const todo = await stub.createTodo("Buy milk");
		expect(todo.title).toBe("Buy milk");
	});

	it("gives up after retries are exhausted", async () => {
		const ns = withTransforms(
			mockNamespace(() => createAppDO({ failCount: 5 }))
		);
		const stub = ns.get("x").with(createRetry<AppDO>(2));

		await expect(stub.createTodo("Buy milk")).rejects.toThrowError(
			"transient-error"
		);
	});

	it("passes through on first success without retrying", async () => {
		const callCount = vi.fn();
		const baseStub = createAppDO();

		const originalCreate = baseStub.createTodo.bind(baseStub);
		baseStub.createTodo = async (title: string) => {
			callCount();
			return originalCreate(title);
		};

		const stub = withTransforms(mockNamespace(() => baseStub))
			.get("x")
			.with(createRetry<AppDO>(3));
		const todo = await stub.createTodo("No failures");

		expect(todo.title).toBe("No failures");
		expect(callCount).toHaveBeenCalledTimes(1);
	});

	it("accepts RetryOptions object with exponential backoff config", async () => {
		const ns = withTransforms(
			mockNamespace(() => createAppDO({ failCount: 1 }))
		);
		const stub = ns
			.get("x")
			.with(
				createRetry<AppDO>({ retries: 2, baseDelay: 1, exponential: true })
			);

		const todo = await stub.createTodo("With backoff");
		expect(todo.title).toBe("With backoff");
	});
});

// ===========================================================================
// 2. Observability Transform
// ===========================================================================

describe("observability transform (e2e)", () => {
	describe("caller-side timing", () => {
		it("emits rpc_ok metric on success", async () => {
			const metrics: MetricEntry[] = [];
			const ns = withTransforms(mockNamespace(createAppDO));
			const stub = ns.get("x").with(
				createObservabilityCaller<AppDO>({
					emitMetric: (m) => metrics.push(m),
				})
			);

			await stub.createTodo("Test");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_ok");
			expect(metrics[0].method).toBe("createTodo");
			expect(metrics[0].id).toBe("app-do-1");
			expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
		});

		it("emits rpc_error metric on failure", async () => {
			const metrics: MetricEntry[] = [];
			const ns = withTransforms(mockNamespace(createAppDO));
			const stub = ns.get("x").with(
				createObservabilityCaller<AppDO>({
					emitMetric: (m) => metrics.push(m),
				})
			);

			await expect(stub.failingMethod()).rejects.toThrow();

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_error");
			expect(metrics[0].method).toBe("failingMethod");
		});
	});

	describe("callee-side timing", () => {
		it("emits method_ok metric on success", async () => {
			const metrics: MetricEntry[] = [];
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [
				createObservabilityCallee<AppDO>((m) => metrics.push(m)),
			]);

			await wrapped.createTodo("Callee test");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("method_ok");
			expect(metrics[0].method).toBe("createTodo");
			expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
		});

		it("emits method_error metric on failure", async () => {
			const metrics: MetricEntry[] = [];
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [
				createObservabilityCallee<AppDO>((m) => metrics.push(m)),
			]);

			await expect(wrapped.failingMethod()).rejects.toThrow();

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("method_error");
			expect(metrics[0].method).toBe("failingMethod");
		});
	});

	describe("full observability (caller + callee)", () => {
		it("annotates results with timing from both sides", async () => {
			const fullObs = createFullObservability<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [fullObs]);
			const stub = withTransforms(mockNamespace(() => wrappedInstance))
				.get("x")
				.with(fullObs);

			const result = (await stub.listTodos()) as unknown as Record<
				string,
				unknown
			>;

			expect(result.__callerMs).toBeGreaterThanOrEqual(0);
			expect(result.__callerMethod).toBe("listTodos");
			expect(result.__callerId).toBe("app-do-1");
			expect(result.__calleeMs).toBeGreaterThanOrEqual(0);
			expect(result.__calleeMethod).toBe("listTodos");
		});
	});

	describe("context-based observability (PRD pattern)", () => {
		it("propagates accountId/coloId from caller to callee via context", async () => {
			const callerMetrics: ContextMetricEntry[] = [];
			const calleeMetrics: ContextMetricEntry[] = [];

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [
				createContextObservabilityCallee<AppDO>((m) => calleeMetrics.push(m)),
			]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(
					createContextObservabilityCaller<AppDO>({
						accountId: "acct-42",
						coloId: "DFW",
						emitMetric: (m) => callerMetrics.push(m),
					})
				);

			const todo = await stub.createTodo("Context test");
			expect(todo.title).toBe("Context test");

			expect(callerMetrics).toHaveLength(1);
			expect(callerMetrics[0].label).toBe("eyeball_ok");
			expect(callerMetrics[0].accountId).toBe("acct-42");
			expect(callerMetrics[0].coloId).toBe("DFW");

			expect(calleeMetrics).toHaveLength(1);
			expect(calleeMetrics[0].label).toBe("cpu_ok");
			expect(calleeMetrics[0].accountId).toBe("acct-42");
			expect(calleeMetrics[0].coloId).toBe("DFW");
		});

		it("callee receives empty context when caller doesn't inject", async () => {
			const calleeMetrics: ContextMetricEntry[] = [];

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [
				createContextObservabilityCallee<AppDO>((m) => calleeMetrics.push(m)),
			]);

			await wrapped.createTodo("No context");

			expect(calleeMetrics).toHaveLength(1);
			expect(calleeMetrics[0].accountId).toBeUndefined();
			expect(calleeMetrics[0].coloId).toBeUndefined();
		});
	});
});

// ===========================================================================
// 3. Result Serialization Bridge
// ===========================================================================

describe("result bridge transform (e2e)", () => {
	describe("separate caller + callee codecs", () => {
		it("wraps success value in envelope and unwraps on caller side", async () => {
			const calleeCodec = createResultCalleeCodec<AppDO>();
			const callerCodec = createResultCallerCodec<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [calleeCodec]);
			const stub = withTransforms(mockNamespace(() => wrappedInstance))
				.get("x")
				.with(callerCodec);

			const todo = await stub.createTodo("Bridged todo");
			expect(todo).toEqual({
				id: "todo-1",
				title: "Bridged todo",
			});
		});

		it("wraps errors in envelope and re-throws on caller side", async () => {
			const calleeCodec = createResultCalleeCodec<AppDO>();
			const callerCodec = createResultCallerCodec<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [calleeCodec]);
			const stub = withTransforms(mockNamespace(() => wrappedInstance))
				.get("x")
				.with(callerCodec);

			const error = await stub.failingMethod().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("permanent-failure");
			expect((error as Error & { code?: string }).code).toBe("EPERM");
		});

		it("callee envelope is visible without caller codec", async () => {
			const calleeCodec = createResultCalleeCodec<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [calleeCodec]);

			const raw = await wrappedInstance.createTodo("Raw envelope");
			expect(raw).toEqual({
				ok: true,
				value: { id: "todo-1", title: "Raw envelope" },
			});
		});
	});

	describe("full bridge (caller().callee())", () => {
		it("round-trips a success value through the bridge", async () => {
			const bridge = createResultBridge<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [bridge]);
			const stub = withTransforms(mockNamespace(() => wrappedInstance))
				.get("x")
				.with(bridge);

			const todo = await stub.createTodo("Full bridge todo");
			expect(todo).toEqual({
				id: "todo-1",
				title: "Full bridge todo",
			});
		});

		it("round-trips an error through the bridge", async () => {
			const bridge = createResultBridge<AppDO>();

			const instance = createAppDO();
			const wrappedInstance = withCalleeTransforms(instance, [bridge]);
			const stub = withTransforms(mockNamespace(() => wrappedInstance))
				.get("x")
				.with(bridge);

			await expect(stub.failingMethod()).rejects.toThrowError(
				"permanent-failure"
			);
		});
	});
});

// ===========================================================================
// 4. Auth/Policy Guard
// ===========================================================================

describe("auth guard transform (e2e)", () => {
	const fakeEnv = { AUTH_SECRET: "s3cret-token" };

	it("allows calls with valid token", async () => {
		const guard = createAuthGuard<AppDO>({
			protectedMethods: ["createTodo"],
			tokenExtractor: (args) => args[1] as string | undefined,
		});

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(instance, [guard], {
			env: fakeEnv,
		});

		const todo = await wrapped.createTodo("Protected", "s3cret-token");
		expect(todo.title).toBe("Protected");
	});

	it("blocks calls with invalid token", async () => {
		const guard = createAuthGuard<AppDO>({
			protectedMethods: ["createTodo"],
			tokenExtractor: (args) => args[1] as string | undefined,
		});

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(instance, [guard], {
			env: fakeEnv,
		});

		await expect(
			wrapped.createTodo("Hacker attempt", "wrong-token")
		).rejects.toThrow(UnauthorizedError);
	});

	it("blocks calls with missing token", async () => {
		const guard = createAuthGuard<AppDO>({
			protectedMethods: ["createTodo"],
			tokenExtractor: (args) => args[1] as string | undefined,
		});

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(instance, [guard], {
			env: fakeEnv,
		});

		await expect(wrapped.createTodo("No token")).rejects.toThrow(
			UnauthorizedError
		);
	});

	it("allows unprotected methods without token", async () => {
		const guard = createAuthGuard<AppDO>({
			protectedMethods: ["deleteTodo"],
			tokenExtractor: (args) => args[1] as string | undefined,
		});

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(instance, [guard], {
			env: fakeEnv,
		});

		const todo = await wrapped.createTodo("Unprotected");
		expect(todo.title).toBe("Unprotected");
	});

	it("guards all methods when protectedMethods is omitted", async () => {
		const guard = createAuthGuard<AppDO>({
			tokenExtractor: (args) =>
				(args as unknown[]).find(
					(a): a is string => typeof a === "string" && a.startsWith("s3")
				),
		});

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(instance, [guard], {
			env: fakeEnv,
		});

		await expect(wrapped.listTodos()).rejects.toThrow(UnauthorizedError);
	});
});

// ===========================================================================
// 5. Composing multiple transforms together
// ===========================================================================

describe("composing multiple transforms (e2e)", () => {
	it("retry + observability on caller side", async () => {
		const metrics: MetricEntry[] = [];

		const ns = withTransforms(
			mockNamespace(() => createAppDO({ failCount: 1 }))
		);
		const stub = ns
			.get("x")
			.with(
				createObservabilityCaller<AppDO>({
					emitMetric: (m) => metrics.push(m),
				})
			)
			.with(createRetry<AppDO>(2));

		const todo = await stub.createTodo("Composed");
		expect(todo.title).toBe("Composed");

		expect(metrics).toHaveLength(1);
		expect(metrics[0].label).toBe("rpc_ok");
	});

	it("auth guard + observability on callee side", async () => {
		const metrics: MetricEntry[] = [];
		const fakeEnv = { AUTH_SECRET: "token123" };

		const instance = createAppDO();
		const wrapped = withCalleeTransforms(
			instance,
			[
				createObservabilityCallee<AppDO>((m) => metrics.push(m)),
				createAuthGuard<AppDO>({
					protectedMethods: ["createTodo"],
					tokenExtractor: (args) => args[1] as string | undefined,
				}),
			],
			{ env: fakeEnv }
		);

		const todo = await wrapped.createTodo("Guarded+Observed", "token123");
		expect(todo.title).toBe("Guarded+Observed");
		expect(metrics).toHaveLength(1);
		expect(metrics[0].label).toBe("method_ok");

		await expect(wrapped.createTodo("Bad", "wrong")).rejects.toThrow(
			UnauthorizedError
		);
		expect(metrics).toHaveLength(2);
		expect(metrics[1].label).toBe("method_error");
	});

	it("full pipeline: retry + result bridge (caller) + auth + observability (callee)", async () => {
		const callerCodec = createResultCallerCodec<AppDO>();
		const calleeCodec = createResultCalleeCodec<AppDO>();

		const metrics: MetricEntry[] = [];
		const fakeEnv = { AUTH_SECRET: "full-pipeline-token" };

		const instance = createAppDO();
		const wrappedInstance = withCalleeTransforms(
			instance,
			[
				createObservabilityCallee<AppDO>((m) => metrics.push(m)),
				createAuthGuard<AppDO>({
					protectedMethods: ["createTodo"],
					tokenExtractor: (args) => args[1] as string | undefined,
				}),
				calleeCodec,
			],
			{ env: fakeEnv }
		);

		const stub = withTransforms(mockNamespace(() => wrappedInstance))
			.get("x")
			.with(callerCodec)
			.with(createRetry<AppDO>(1));

		const todo = await stub.createTodo("Full pipeline", "full-pipeline-token");
		expect(todo).toEqual({
			id: "todo-1",
			title: "Full pipeline",
		});

		expect(metrics.some((m) => m.label === "method_ok")).toBe(true);
	});
});

// ===========================================================================
// 6. Better-Result Bridge (PRD pattern)
// ===========================================================================

describe("better-result bridge (e2e)", () => {
	describe("separate caller + callee codecs", () => {
		it("round-trips a Result.ok through serialize → deserialize", async () => {
			const callee = createBetterResultCalleeCodec<AppDO>();
			const caller = createBetterResultCallerCodec<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(caller);

			const result = await stub.createItem("Widget");

			// Caller codec deserializes back into a Result instance
			expect(Result.isOk(result)).toBe(true);
			if (Result.isOk(result)) {
				expect(result.value).toEqual({ id: "item-1", title: "Widget" });
			}
		});

		it("round-trips a Result.err through serialize → deserialize", async () => {
			const callee = createBetterResultCalleeCodec<AppDO>();
			const caller = createBetterResultCallerCodec<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(caller);

			const result = await stub.failNetwork();

			expect(Result.isError(result)).toBe(true);
			if (Result.isError(result)) {
				expect(result.error).toMatchObject({
					_tag: "RetryableNetworkError",
					message: "upstream timeout",
				});
			}
		});

		it("passes through non-Result values unchanged", async () => {
			const callee = createBetterResultCalleeCodec<AppDO>();
			const caller = createBetterResultCallerCodec<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(caller);

			// plainMethod returns a raw string, not a Result
			const result = await stub.plainMethod();
			expect(result).toBe("not a Result");
		});

		it("callee serialization is visible without caller codec", async () => {
			const callee = createBetterResultCalleeCodec<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);

			const raw = await wrapped.createItem("Visible");
			// Without the caller codec, we see the serialized wire format
			expect(raw).toEqual({
				status: "ok",
				value: { id: "item-1", title: "Visible" },
			});
		});
	});

	describe("full bridge (caller().callee())", () => {
		it("round-trips a success Result through the bridge", async () => {
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge);

			const result = await stub.createItem("Bridged");

			expect(Result.isOk(result)).toBe(true);
			if (Result.isOk(result)) {
				expect(result.value).toEqual({ id: "item-1", title: "Bridged" });
			}
		});

		it("round-trips an error Result through the bridge", async () => {
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge);

			const result = await stub.failNetwork();

			expect(Result.isError(result)).toBe(true);
		});
	});

	describe("metricsWithBetterResult (error-type metrics, manual TStub)", () => {
		it("emits rpc_ok for successful Result values", async () => {
			const metrics: BetterResultMetricEntry[] = [];
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);

			// Stack order: bridge codec first, then metrics (sees decoded Result)
			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge)
				.with(
					createMetricsWithBetterResult<AppDO>({
						emitMetrics: (m) => metrics.push(m),
					})
				);

			await stub.createItem("Tracked");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_ok");
			expect(metrics[0].method).toBe("createItem");
		});

		it("emits rpc_error_retryable_network for RetryableNetworkError", async () => {
			const metrics: BetterResultMetricEntry[] = [];
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge)
				.with(
					createMetricsWithBetterResult<AppDO>({
						emitMetrics: (m) => metrics.push(m),
					})
				);

			await stub.failNetwork();

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_error_retryable_network");
			expect(metrics[0].method).toBe("failNetwork");
		});

		it("emits rpc_error_user_input for UserInputError", async () => {
			const metrics: BetterResultMetricEntry[] = [];
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge)
				.with(
					createMetricsWithBetterResult<AppDO>({
						emitMetrics: (m) => metrics.push(m),
					})
				);

			await stub.createItem("");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_error_user_input");
			expect(metrics[0].method).toBe("createItem");
		});

		it("emits rpc_ok for non-Result plain values", async () => {
			const metrics: BetterResultMetricEntry[] = [];
			const bridge = createBetterResultBridge<AppDO>();

			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [bridge]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(bridge)
				.with(
					createMetricsWithBetterResult<AppDO>({
						emitMetrics: (m) => metrics.push(m),
					})
				);

			await stub.plainMethod();

			expect(metrics).toHaveLength(1);
			// Not a Result, so it's treated as "ok"
			expect(metrics[0].label).toBe("rpc_ok");
		});
	});

	describe("createMetricsFromCodec (typed via createTransform<typeof codec>())", () => {
		it("emits rpc_ok for successful Result values", async () => {
			const metrics: BetterResultMetricEntry[] = [];

			// Codec with typed output
			const codec = createBetterResultCallerCodec<
				AppDO,
				Result<Item, AppError>
			>();

			// Metrics inferred from codec — no explicit TStub or TOutput needed
			const typedMetrics = createMetricsFromCodec(codec, {
				emitMetrics: (m) => metrics.push(m),
			});

			const callee = createBetterResultCalleeCodec<AppDO>();
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(codec)
				.with(typedMetrics);

			await stub.createItem("TypedMetrics");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_ok");
			expect(metrics[0].method).toBe("createItem");
		});

		it("emits rpc_error_retryable_network for RetryableNetworkError", async () => {
			const metrics: BetterResultMetricEntry[] = [];

			const codec = createBetterResultCallerCodec<
				AppDO,
				Result<Item, AppError>
			>();
			const typedMetrics = createMetricsFromCodec(codec, {
				emitMetrics: (m) => metrics.push(m),
			});

			const callee = createBetterResultCalleeCodec<AppDO>();
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(codec)
				.with(typedMetrics);

			await stub.failNetwork();

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_error_retryable_network");
			expect(metrics[0].method).toBe("failNetwork");
		});

		it("emits rpc_error_user_input for UserInputError", async () => {
			const metrics: BetterResultMetricEntry[] = [];

			const codec = createBetterResultCallerCodec<
				AppDO,
				Result<Item, AppError>
			>();
			const typedMetrics = createMetricsFromCodec(codec, {
				emitMetrics: (m) => metrics.push(m),
			});

			const callee = createBetterResultCalleeCodec<AppDO>();
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(codec)
				.with(typedMetrics);

			await stub.createItem("");

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_error_user_input");
			expect(metrics[0].method).toBe("createItem");
		});

		it("emits rpc_ok for non-Result plain values", async () => {
			const metrics: BetterResultMetricEntry[] = [];

			const codec = createBetterResultCallerCodec<
				AppDO,
				Result<Item, AppError>
			>();
			const typedMetrics = createMetricsFromCodec(codec, {
				emitMetrics: (m) => metrics.push(m),
			});

			const callee = createBetterResultCalleeCodec<AppDO>();
			const instance = createAppDO();
			const wrapped = withCalleeTransforms(instance, [callee]);

			const stub = withTransforms(mockNamespace(() => wrapped))
				.get("x")
				.with(codec)
				.with(typedMetrics);

			await stub.plainMethod();

			expect(metrics).toHaveLength(1);
			expect(metrics[0].label).toBe("rpc_ok");
		});
	});
});
