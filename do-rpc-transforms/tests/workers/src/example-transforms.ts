import { createTransform } from "../../../src";
import type { OutputFn } from "../../../src";

/**
 * Reusable transforms for the multi-DO example.
 *
 * These transforms demonstrate a production-like pipeline where
 * multiple Durable Objects share the same caller/callee transforms
 * but compose them differently:
 *
 *   InventoryDO (raw returns):
 *     caller: throttle → tenantContext → [wire]
 *     callee: featureGate → featureCheck → method
 *
 *   OrderDO (Result returns + codec):
 *     caller: throttle → tenantContext → codec → [wire]
 *     callee: featureCheck → codec → method
 *
 * The key patterns shown:
 *
 * - `throttle`: caller-side rate limiting with a generic `makeError`
 *   callback so the same transform works with both raw and Result DOs
 * - `tenantContext`: injects tenantId into context
 * - `featureGate`: callee-side, reads tenantId, fetches and appends
 *   enabledFeatures to context, short-circuits if tenantId missing
 * - `featureCheck`: callee-side, reads accumulated context (with or
 *   without enabledFeatures), may short-circuit if feature is disabled
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Context injected by the `tenantContext` caller transform.
 * All downstream transforms can read `tenantId` from context.
 */
export type TenantContext = {
	tenantId: string;
};

/**
 * Context appended by the `featureGate` callee transform.
 * Present only when featureGate is in the pipeline (InventoryDO).
 */
export type FeatureContext = {
	enabledFeatures: string[];
};

/**
 * The full context shape.  Transforms that may or may not see
 * `enabledFeatures` use `Partial<FeatureContext>` for the optional part.
 */
export type FullContext = TenantContext & Partial<FeatureContext>;

/**
 * External service for looking up a tenant's enabled features.
 * The test provides a mock; production would call a real service.
 */
export type FeatureService = {
	getFeatures(tenantId: string): Promise<string[]>;
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Returned by `throttle` when the caller exceeds the rate limit.
 * Plain object (not a class) so it survives structured clone over RPC.
 */
export type ThrottledResponse = {
	readonly success: false;
	readonly message: string;
};

/**
 * Returned by `featureGate` when tenantId is missing from context.
 */
export type MissingTenantResponse = {
	readonly tag: "MissingTenantResponse";
	readonly method: string;
	readonly message: string;
};

/**
 * Returned by `featureCheck` when the required feature is not enabled.
 */
export type FeatureDisabledResponse = {
	readonly tag: "FeatureDisabledResponse";
	readonly feature: string;
	readonly method: string;
	readonly message: string;
};

// ---------------------------------------------------------------------------
// throttle — caller-side only
//
// In-memory sliding-window rate limiter.  Tracks call timestamps in a
// closure-scoped array.  When the window is full, short-circuits by
// returning `{ success: false, message }`.
//
// Uses an OutputFn so the type system surfaces the short-circuit:
// each method's return becomes `OriginalReturn | ThrottledResponse`.
// ---------------------------------------------------------------------------

/**
 * OutputFn that unions each method's return type with ThrottledResponse.
 */
interface AddThrottledResponse extends OutputFn {
	readonly Out: this["In"] | ThrottledResponse;
}

export const throttle = createTransform<
	object,
	{},
	Record<string, unknown>,
	AddThrottledResponse
>().caller((maxCalls: number, windowMs: number) => {
	const timestamps: number[] = [];

	return async ({ method, next }) => {
		const now = Date.now();
		const cutoff = now - windowMs;

		// Prune expired timestamps
		while (timestamps.length > 0 && timestamps[0]! < cutoff) {
			timestamps.shift();
		}

		if (timestamps.length >= maxCalls) {
			return {
				success: false as const,
				message: `Rate limit exceeded for "${method}"`,
			};
		}

		timestamps.push(now);
		return next();
	};
});

// ---------------------------------------------------------------------------
// tenantContext — caller-side only
//
// Injects tenantId into context so downstream transforms
// (both caller-side and callee-side via the envelope) can read it.
// ---------------------------------------------------------------------------

export const tenantContext = createTransform<
	object,
	{},
	TenantContext
>().caller((tenantId: string) => async ({ next }) => {
	return next({ context: { tenantId } });
});

// ---------------------------------------------------------------------------
// featureGate — callee-side only (InventoryDO only)
//
// 1. Reads tenantId from context
// 2. If missing → short-circuits with MissingTenantResponse
// 3. Fetches enabled features for the tenant
// 4. Appends { enabledFeatures } to context for downstream transforms
//
// This transform is only in InventoryDO's pipeline.  OrderDO skips it,
// so featureCheck must handle the absence of enabledFeatures.
// ---------------------------------------------------------------------------

export const featureGate = createTransform<object, {}, FullContext>().callee(
	(featureService: FeatureService) =>
		async ({ method, context, next }) => {
			const tenantId = context.tenantId;

			if (!tenantId) {
				// Return directly — skips all downstream callee transforms
				// (featureCheck, codec, the actual method).
				const response: MissingTenantResponse = {
					tag: "MissingTenantResponse",
					method,
					message: `Missing tenantId in context for method "${method}"`,
				};
				return response;
			}

			const features = await featureService.getFeatures(tenantId);

			return next({
				context: { enabledFeatures: features },
			});
		}
);

// ---------------------------------------------------------------------------
// featureCheck — callee-side only (both DOs)
//
// Guards method execution behind a required feature flag.
//
// 1. If enabledFeatures is already in context (featureGate ran),
//    uses it directly �� no extra service call.
// 2. If not (OrderDO pipeline), reads tenantId and fetches features
//    from the service.
// 3. If the required feature is not in the list, short-circuits with
//    FeatureDisabledResponse.
// 4. Otherwise, passes through to the next transform / method.
// ---------------------------------------------------------------------------

export const featureCheck = createTransform<object, {}, FullContext>().callee(
	(requiredFeature: string, featureService: FeatureService) =>
		async ({ method, context, next }) => {
			let features: string[];

			if (
				context.enabledFeatures &&
				context.enabledFeatures.length > 0
			) {
				// featureGate already fetched and appended features
				features = context.enabledFeatures;
			} else if (context.tenantId) {
				// No featureGate in pipeline — fetch directly
				features = await featureService.getFeatures(context.tenantId);
			} else {
				// No tenant info at all — deny
				features = [];
			}

			if (!features.includes(requiredFeature)) {
				const response: FeatureDisabledResponse = {
					tag: "FeatureDisabledResponse",
					feature: requiredFeature,
					method,
					message: `Feature "${requiredFeature}" is not enabled for method "${method}"`,
				};
				return next({ result: response });
			}

			return next();
		}
);
