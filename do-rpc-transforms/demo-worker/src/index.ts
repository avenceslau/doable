import {
  TRANSFORM_CALL_ID_CONTEXT_KEY,
  createTransform,
  useDOTransforms,
  withTransforms,
} from "../../src";
import { DurableObject } from "cloudflare:workers";
import { Result } from "better-result";
import { calleeRateLimiter, codec } from "./transforms";

function isResult(value: unknown): value is Result<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		((value as Record<string, unknown>).status === "ok" ||
			(value as Record<string, unknown>).status === "error")
	);
}

type DemoContext = {
  requestId?: string;
  route?: string;
  instanceTag?: string;
  [TRANSFORM_CALL_ID_CONTEXT_KEY]?: string;
};

type DemoMetaLog = {
  method: string;
  status: "ok" | "error";
  requestId?: string;
  route?: string;
  instanceTag?: string;
  callId?: string;
  timestamp: number;
};

const demoAudit = createTransform<DemoDO, {}, DemoContext>()
  .calleeParams<{ scope: string }>()
  .callee(
    ({ scope }) =>
      async ({ method, context, instance, next }) => {
        const value = await next();
        const status =
          isResult(value) && Result.isError(value) ? "error" : "ok";

        instance.__metaLog.push({
          method,
          status,
          requestId: context.requestId,
          route: context.route,
          instanceTag: `${scope}:${method}`,
          callId: context[TRANSFORM_CALL_ID_CONTEXT_KEY],
          timestamp: Date.now(),
        });

        return value;
      },
  );

export class DemoDO extends DurableObject {
  __metaLog: DemoMetaLog[] = [];
  #count = 0;

  async greet(name: string) {
    this.#count += 1;
    return Result.ok({ message: `Hello, ${name}!`, count: this.#count });
  }

  async getLastMeta() {
    return this.__metaLog.at(-1) ?? null;
  }
}

export const DemoDOWithTransforms = useDOTransforms(DemoDO)
  .with(calleeRateLimiter("greet", 3, 10_000))
  .with(codec)
  .with(demoAudit.calleeConfig({ scope: "demo-do" }))
  .done();

const demoCallerMetadata = createTransform<
  DurableObjectStub<InstanceType<typeof DemoDOWithTransforms>>,
  {},
  DemoContext
>()
  .callerParams<{ requestId: string; route: string }>()
  .caller(({ requestId, route }) => async ({ next }) => {
    return next({
      context: {
        requestId,
        route,
      },
    });
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/demo") {
      return new Response(
        "Try GET /demo?name=Ada (rate limited after 3 calls/10s)",
        {
          status: 200,
        },
      );
    }

    const name = url.searchParams.get("name") ?? "world";
    const requestId = crypto.randomUUID();

    const ns = withTransforms(env.DEMO_DO);
    const id = ns.idFromName("demo");
    const stub = ns
      .get(id)
      .with(
        demoCallerMetadata.callerConfig({ requestId, route: url.pathname }),
      );
    const typedStub = stub.with(codec);

    const result = await typedStub.greet(name);

    const meta = await typedStub.getLastMeta();

    if (Result.isError(result)) {
      return Response.json(
        {
          ok: false,
          error: {
            tag: result.error._tag,
            message: result.error.message,
          },
          meta,
        },
        { status: 200 },
      );
    }

    return Response.json({
      ok: true,
      result: result.value,
      meta,
    });
  },
};
