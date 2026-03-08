interface Env {
	COUNTER: DurableObjectNamespace<import("./index").CounterDO>;
	TRANSFORMED_COUNTER: DurableObjectNamespace<
		import("./index").TransformedCounterDO
	>;
	RESULT_DO: DurableObjectNamespace<import("./index").ResultDO>;
	METRICS_DO: DurableObjectNamespace<import("./index").MetricsDO>;
	SINGLE_FLIGHT_DO: DurableObjectNamespace<import("./index").SingleFlightDO>;
	FULL_PIPELINE_DO: DurableObjectNamespace<import("./index").FullPipelineDO>;
	INVENTORY_DO: DurableObjectNamespace<import("./index").InventoryDO>;
	ORDER_DO: DurableObjectNamespace<import("./index").OrderDO>;
	DEMO_DO: DurableObjectNamespace<import("./index").DemoDO>;
}
