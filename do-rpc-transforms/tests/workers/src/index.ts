/**
 * Worker entry point with real Durable Object classes for integration testing.
 *
 * Each DO class demonstrates a different transform registration pattern:
 *
 * - CounterDO: plain DO, no transforms (used with caller-side transforms)
 * - TransformedCounterDO: uses class-level transform builder
 *   The callee transform doubles the return value of every method,
 *   which is observable from the test side across the RPC boundary.
 * - ResultDO: returns `Result` values from better-result, uses
 *   decorator-registered better-result callee codec to serialize
 *   Results over the wire.
 * - MetricsDO: demonstrates full pipeline with caller+callee metrics,
 *   context passing, and better-result codec.  Transforms are defined
 *   in ./transforms.ts and shared with the test file.
 * - DemoDO: small demo Durable Object invoked from worker `fetch`.
 */
import { Result, TaggedError } from "better-result";
import { DurableObject } from "cloudflare:workers";
import {
	createTransform,
	useDOTransforms,
} from "../../../src";
// ---------------------------------------------------------------------------
// InventoryDO — raw returns, uses featureGate + featureCheck
//
// Manages stock levels for SKUs.  Returns plain values (number, string[]).
//
// Callee pipeline: featureGate → featureCheck → method
//
// featureGate fetches the tenant's enabled features and appends them
// to context.  featureCheck reads the cached features and blocks the
// call if "inventory" is not enabled.
//
// The feature service is self-contained here because module-level
// variables are not shared between the test and DO modules in workerd.
// ---------------------------------------------------------------------------

import { featureCheck, featureGate } from "./example-transforms";
import { codec, metrics, singleFlight } from "./transforms";
import type { CalleeTransform } from "../../../src";
import type { FeatureService } from "./example-transforms";
import type { MetricLogEntry } from "./transforms";

export type {
	MetricLogEntry,
	SingleFlightMetricEntry,
	SentryReport,
	RateLimitService,
} from "./transforms";
export {
	MethodBusyError,
	NetworkError,
	TimeoutError,
	UnknownRpcError,
	RateLimitError,
} from "./transforms";

// ---------------------------------------------------------------------------
// CounterDO — plain DO, no callee transforms
// ---------------------------------------------------------------------------

export class CounterDO extends DurableObject {
	#count = 0;

	async increment(by = 1): Promise<number> {
		this.#count += by;
		return this.#count;
	}

	async getCount(): Promise<number> {
		return this.#count;
	}

	async echo(...args: unknown[]): Promise<unknown[]> {
		return args;
	}
}

// ---------------------------------------------------------------------------
// DemoDO — small class used by the worker fetch demo route
// ---------------------------------------------------------------------------

export class DemoDO extends DurableObject {
	#count = 0;

	async greet(name: string): Promise<{ message: string; count: number }> {
		this.#count += 1;
		return {
			message: `Hello, ${name}!`,
			count: this.#count,
		};
	}
}

// ---------------------------------------------------------------------------
// TransformedCounterDO — uses class decorator
// ---------------------------------------------------------------------------

/**
 * Callee transform that doubles numeric return values.
 * This produces an observable effect across the RPC boundary so
 * tests can verify the transform actually ran.
 */
const doublingTransform: CalleeTransform<TransformedCounterDO> =
	createTransform<TransformedCounterDO>().callee(() => async ({ next }) => {
		const result = await next();
		if (typeof result === "number") {
			return result * 2;
		}
		return result;
	})();

export class TransformedCounterDO extends DurableObject {
	#count = 0;

	async increment(by = 1): Promise<number> {
		this.#count += by;
		return this.#count;
	}

	async getCount(): Promise<number> {
		return this.#count;
	}
}

useDOTransforms(TransformedCounterDO).with(doublingTransform).done();

// ---------------------------------------------------------------------------
// ResultDO — returns Result values, uses better-result callee codec
// ---------------------------------------------------------------------------

export class ItemNotFoundError extends TaggedError("ItemNotFoundError")<{
	message: string;
}>() {}

export class ValidationError extends TaggedError("ValidationError")<{
	message: string;
}>() {}

const resultCalleeCodec = codec()();

export class ResultDO extends DurableObject {
	#items: Array<{ id: string; title: string }> = [];
	#nextId = 1;

	async createItem(
		title: string
	): Promise<Result<{ id: string; title: string }, ValidationError>> {
		if (!title || title.trim().length === 0) {
			return Result.err(new ValidationError({ message: "title is required" }));
		}

		const item = { id: `item-${this.#nextId++}`, title };
		this.#items.push(item);
		return Result.ok(item);
	}

	async getItem(
		id: string
	): Promise<Result<{ id: string; title: string }, ItemNotFoundError>> {
		const item = this.#items.find((i) => i.id === id);
		if (!item) {
			return Result.err(
				new ItemNotFoundError({ message: `item ${id} not found` })
			);
		}
		return Result.ok(item);
	}

	async plainMethod(): Promise<string> {
		return "not a Result";
	}
}

useDOTransforms(ResultDO).with(resultCalleeCodec).done();

// ---------------------------------------------------------------------------
// MetricsDO — better-result + metrics with context passing
//
// Transforms are defined in ./transforms.ts:
//   caller: metrics(accountId) → codec → [wire]
//   callee: metrics → codec → method
//
// The caller injects accountId via context. The callee reads it
// and records a metric entry that includes the method result.
// ---------------------------------------------------------------------------

export class MetricsDO extends DurableObject {

	#items: Array<{ id: string; title: string }> = [];
	#nextId = 1;
	__metricsLog: MetricLogEntry[] = [];

	async createItem(
		title: string
	): Promise<Result<{ id: string; title: string }, ValidationError>> {
		if (!title || title.trim().length === 0) {
			return Result.err(new ValidationError({ message: "title is required" }));
		}
		const item = { id: `item-${this.#nextId++}`, title };
		this.#items.push(item);
		return Result.ok(item);
	}

	async getItem(
		id: string
	): Promise<Result<{ id: string; title: string }, ItemNotFoundError>> {
		const item = this.#items.find((i) => i.id === id);
		if (!item) {
			return Result.err(
				new ItemNotFoundError({ message: `item ${id} not found` })
			);
		}
		return Result.ok(item);
	}

	/**
	 * Returns the metrics log recorded by the callee metrics transform.
	 * This lets the test verify that context (requestId, accountId)
	 * arrived on the callee side.
	 */
	async getMetrics(): Promise<MetricLogEntry[]> {
		return this.__metricsLog;
	}
}

useDOTransforms(MetricsDO).with(metrics("unused")()).with(codec()()).done();

// ---------------------------------------------------------------------------
// SingleFlightDO — demonstrates the singleFlight transform
//
// Uses singleFlight + codec callee transforms.
// `slowIncrement` sleeps for a configurable duration so concurrent
// calls to the same method will be rejected with MethodBusyError.
// ---------------------------------------------------------------------------

export class SingleFlightDO extends DurableObject {
	#count = 0;
	__inflight?: Set<string>;

	async increment(by = 1): Promise<Result<number, never>> {
		this.#count += by;
		return Result.ok(this.#count);
	}

	async slowIncrement(
		by: number,
		delayMs: number
	): Promise<Result<number, never>> {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		this.#count += by;
		return Result.ok(this.#count);
	}

	async getCount(): Promise<Result<number, never>> {
		return Result.ok(this.#count);
	}
}

useDOTransforms(SingleFlightDO).with(singleFlight([])()).with(codec()()).done();

// ---------------------------------------------------------------------------
// FullPipelineDO — exercises the complete transform stack
//
// Callee: singleFlight → metrics → codec → method
// Caller: errorBoundary → singleFlight → metrics → codec → [wire]
//
// Methods can return Results, throw known errors (network/timeout),
// or throw unknown errors so every transform gets exercised.
// ---------------------------------------------------------------------------

export class FullPipelineDO extends DurableObject {
	#count = 0;
	__metricsLog: MetricLogEntry[] = [];
	__inflight?: Set<string>;

	async increment(by = 1): Promise<Result<number, never>> {
		this.#count += by;
		return Result.ok(this.#count);
	}

	async slowIncrement(
		by: number,
		delayMs: number
	): Promise<Result<number, never>> {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		this.#count += by;
		return Result.ok(this.#count);
	}

	async getCount(): Promise<Result<number, never>> {
		return Result.ok(this.#count);
	}

	async getMetrics(): Promise<MetricLogEntry[]> {
		return this.__metricsLog;
	}
}

useDOTransforms(FullPipelineDO)
	.with(singleFlight([])())
	.with(metrics("unused")())
	.with(codec()())
	.done();

/**
 * In-memory feature service for integration testing.
 * Maps tenantId → list of enabled features.
 */
const inventoryFeatureService: FeatureService = {
	async getFeatures(tenantId: string): Promise<string[]> {
		const tenantFeatures: Record<string, string[]> = {
			"tenant-full": ["inventory", "orders", "analytics"],
			"tenant-inventory-only": ["inventory"],
			"tenant-orders-only": ["orders"],
			"tenant-none": [],
		};
		return tenantFeatures[tenantId] ?? [];
	},
};

export class InventoryDO extends DurableObject {
	#stock = new Map<string, number>();

	async addStock(sku: string, qty: number): Promise<number> {
		const current = this.#stock.get(sku) ?? 0;
		const updated = current + qty;
		this.#stock.set(sku, updated);
		return updated;
	}

	async getStock(sku: string): Promise<number> {
		return this.#stock.get(sku) ?? 0;
	}

	async listSkus(): Promise<string[]> {
		return Array.from(this.#stock.keys());
	}
}

useDOTransforms(InventoryDO)
	.with(featureGate(inventoryFeatureService))
	.with(featureCheck("inventory", inventoryFeatureService))
	.done();

// ---------------------------------------------------------------------------
// OrderDO — Result returns + codec, uses featureCheck (no featureGate)
//
// Manages orders.  Returns `Result<T, E>` from better-result.
//
// Callee pipeline: featureCheck → codec → method
//
// OrderDO does NOT use featureGate (skips the context appender).
// featureCheck fetches features directly using tenantId from context.
// codec serializes Result values for the wire.
// ---------------------------------------------------------------------------

export class OrderNotFoundError extends TaggedError("OrderNotFoundError")<{
	message: string;
}>() {}

export class InsufficientStockError extends TaggedError(
	"InsufficientStockError"
)<{
	message: string;
}>() {}

const orderFeatureService: FeatureService = {
	async getFeatures(tenantId: string): Promise<string[]> {
		const tenantFeatures: Record<string, string[]> = {
			"tenant-full": ["inventory", "orders", "analytics"],
			"tenant-inventory-only": ["inventory"],
			"tenant-orders-only": ["orders"],
			"tenant-none": [],
		};
		return tenantFeatures[tenantId] ?? [];
	},
};

export class OrderDO extends DurableObject {
	#orders: Array<{ id: string; sku: string; qty: number }> = [];
	#nextId = 1;

	async placeOrder(
		sku: string,
		qty: number
	): Promise<
		Result<{ id: string; sku: string; qty: number }, ValidationError>
	> {
		if (!sku || sku.trim().length === 0) {
			return Result.err(new ValidationError({ message: "sku is required" }));
		}
		if (qty <= 0) {
			return Result.err(
				new ValidationError({ message: "qty must be positive" })
			);
		}

		const order = { id: `order-${this.#nextId++}`, sku, qty };
		this.#orders.push(order);
		return Result.ok(order);
	}

	async getOrder(
		id: string
	): Promise<
		Result<{ id: string; sku: string; qty: number }, OrderNotFoundError>
	> {
		const order = this.#orders.find((o) => o.id === id);
		if (!order) {
			return Result.err(
				new OrderNotFoundError({ message: `order ${id} not found` })
			);
		}
		return Result.ok(order);
	}

	async listOrders(): Promise<
		Result<Array<{ id: string; sku: string; qty: number }>, never>
	> {
		return Result.ok([...this.#orders]);
	}
}

useDOTransforms(OrderDO)
	.with(featureCheck("orders", orderFeatureService))
	.with(codec()())
	.done();

// ---------------------------------------------------------------------------
// Default export (required by wrangler)
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/demo") {
			const name = url.searchParams.get("name") ?? "world";
			const id = env.DEMO_DO.idFromName("demo");
			const stub = env.DEMO_DO.get(id);
			const result = await stub.greet(name);
			return Response.json(result);
		}

		return new Response("do-rpc-transforms worker\nTry /demo?name=Ada");
	},
};
