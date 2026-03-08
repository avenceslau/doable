# @avenceslau/doable

Typed, composable transform hooks for Durable Object RPC.

Use this package to add cross-cutting behavior (metrics, retries, codecs, rate limits, context propagation, error shaping) without rewriting every DO method.

## Status

This package is currently prerelease and iterating quickly.

## Install

```bash
npm i @avenceslau/doable
```

## Core concepts

- **Caller transforms** run on the stub side (`stub.with(...)`)
- **Callee transforms** run inside the Durable Object (`useDOTransforms(...).with(...).done()`)
- **`context`** is per-call metadata that flows through the transform chain
- **`TRANSFORM_CALL_ID_CONTEXT_KEY`** is an internal per-call UUID key added automatically

## Quick start

### 1) Caller-side transforms

Wrap a namespace once, then chain `.with(...)` on stubs.

```ts
import { createTransform, withTransforms } from "@avenceslau/doable";

type Ctx = { requestId: string };

const injectRequestId = createTransform<MyDO, {}, Ctx>()
	.callerParams<{ requestId: string }>()
	.caller(({ requestId }) => async ({ next }) => {
		return next({ context: { requestId } });
	});

const ns = withTransforms(env.MY_DO);
const id = ns.idFromName("demo");
const stub = ns.get(id).with(injectRequestId.callerConfig({ requestId: crypto.randomUUID() }));

await stub.myMethod();
```

### 2) Callee-side transforms

Register transforms once on the DO class.

```ts
import { createTransform, useDOTransforms } from "@avenceslau/doable";

const audit = createTransform<MyDO>()
	.callee(() => async ({ method, context, next }) => {
		const result = await next();
		console.log("method", method, "requestId", context.requestId);
		return result;
	});

export class MyDO extends DurableObject {
	async myMethod() {
		return "ok";
	}
}

useDOTransforms(MyDO).with(audit).done();
```

## Parameterized caller/callee configs

`createTransform` supports independent config for each side.

```ts
const policy = createTransform<MyDO, {}, { requestId?: string }>()
	.callerParams<{ requestId: string }>()
	.caller(({ requestId }) => async ({ next }) => {
		return next({ context: { requestId } });
	})
	.calleeParams<{ maxCalls: number }>()
	.callee(({ maxCalls }) => async ({ next, instance, method }) => {
		// example policy using maxCalls
		return next();
	});

// caller side
stub.with(policy.callerConfig({ requestId: "r-1" }));

// callee side
useDOTransforms(MyDO).with(policy.calleeConfig({ maxCalls: 3 })).done();
```

If a side has no params, you can pass it directly:

```ts
const codec = createTransform<object>()
	.callerParams<void>()
	.caller(() => async ({ next }) => next())
	.calleeParams<void>()
	.callee(() => async ({ next }) => next());

stub.with(codec);
useDOTransforms(MyDO).with(codec).done();
```

## Method-specific callee transforms

Apply transforms only to one method:

```ts
useDOTransforms(MyDO)
	.method("createTodo")
	.with(rateLimitTransform)
	.done();
```

## Context API

Use `next({ context: ... })` to set/merge metadata.

```ts
const t = createTransform<MyDO, {}, { traceId?: string }>()
	.caller(() => async ({ next }) => {
		return next({ context: { traceId: "abc" } });
	})
	.callee(() => async ({ context, next }) => {
		console.log(context.traceId);
		return next();
	});
```

## DO output typing with `.done()`

`useDOTransforms(...).done()` finalizes class typing so callee transform output effects are reflected in stub method return types.

```ts
export const MyDOWithTransforms = useDOTransforms(MyDO)
	.with(codec)
	.with(rateLimit)
	.done();

type Env = {
	MY_DO: DurableObjectNamespace<InstanceType<typeof MyDOWithTransforms>>;
};
```

## API summary

- `createTransform<TStub, TContract?, TContext?, TOutput?>()`
- `withTransforms(namespace)`
- `withCalleeTransforms(instance, transforms, options?)`
- `useDOTransforms(MyDO).with(...).method("...").with(...).done()`
- `TRANSFORM_CALL_ID_CONTEXT_KEY`

## More examples

See `examples/` for ready-to-use recipes, including:

- caller retry
- caller rate limiting (`better-result`)
- callee auth guard
- callee single inflight
- context observability
- `better-result` codec
- caller error boundary

## Development

```bash
pnpm run check:type
pnpm run type:tests
pnpm run test
pnpm run test:workers
```

Demo worker:

```bash
pnpm run demo:dev
pnpm run demo:deploy
```
