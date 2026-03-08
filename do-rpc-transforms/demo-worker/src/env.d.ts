interface Env {
	DEMO_DO: DurableObjectNamespace<
		InstanceType<typeof import("./index").DemoDOWithTransforms>
	>;
}
