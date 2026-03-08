import { createTransform } from "../src";

export type RpcObsContext = {
	requestId?: string;
	accountId?: string;
	eyeballColoId?: string;
	calleeColoId?: string;
};

export type MetricEntry = {
	label: string;
	method: string;
	durationMs: number;
	requestId?: string;
	accountId?: string;
	eyeballColoId?: string;
	calleeColoId?: string;
};

export function createObservabilityTransform<TStub extends object>(
	emitMetric: (entry: MetricEntry) => void
) {
	return createTransform<TStub, {}, RpcObsContext>()
		.callerParams<{ requestId: string; accountId: string; eyeballColoId: string }>()
		.caller(({ requestId, accountId, eyeballColoId }) => {
			return async ({ method, next }) => {
				const started = performance.now();
				try {
					return await next({
						context: { requestId, accountId, eyeballColoId },
					});
				} finally {
					emitMetric({
						label: "caller_duration",
						method,
						durationMs: performance.now() - started,
						requestId,
						accountId,
						eyeballColoId,
					});
				}
			};
		})
		.calleeParams<{ calleeColoId: string }>()
		.callee(({ calleeColoId }) => {
			return async ({ method, context, next }) => {
				const started = performance.now();
				const nextContext: RpcObsContext = { ...context, calleeColoId };
				try {
					return await next({ context: nextContext });
				} finally {
					emitMetric({
						label: "callee_duration",
						method,
						durationMs: performance.now() - started,
						requestId: nextContext.requestId,
						accountId: nextContext.accountId,
						eyeballColoId: nextContext.eyeballColoId,
						calleeColoId: nextContext.calleeColoId,
					});
				}
			};
		});
}
