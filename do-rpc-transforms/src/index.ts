type UnknownAsyncFunction = (...args: never[]) => Promise<unknown>;

type CallableKey<TStub extends object> = {
	[K in keyof TStub]-?: TStub[K] extends UnknownAsyncFunction ? K : never;
}[keyof TStub] &
	string;

type AnyCallableKey<TStub extends object> = [CallableKey<TStub>] extends [never]
	? string
	: CallableKey<TStub>;

type CallableMethod<
	TStub extends object,
	K extends CallableKey<TStub>,
> = Extract<TStub[K], UnknownAsyncFunction>;

type MergeConflictingContractKeys<
	TExisting extends object,
	TIncoming extends object,
> = {
	[K in keyof TExisting & keyof TIncoming]: [TExisting[K]] extends [
		TIncoming[K],
	]
		? [TIncoming[K]] extends [TExisting[K]]
			? never
			: K
		: K;
}[keyof TExisting & keyof TIncoming];

type MergeContractsOrNever<
	TExisting extends object,
	TIncoming extends object,
> = [MergeConflictingContractKeys<TExisting, TIncoming>] extends [never]
	? TExisting & TIncoming
	: never;

type EnsureCompatibleContracts<
	TExisting extends object,
	TIncoming extends object,
> = [MergeContractsOrNever<TExisting, TIncoming>] extends [never]
	? {
			readonly __contract_conflict__: never;
		}
	: unknown;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type TransformContext = Record<string, unknown>;

export const TRANSFORM_CALL_ID_CONTEXT_KEY =
	"__doRpcTransformsCallId" as const;

export type TransformCallIdContext = TransformContext & {
	[TRANSFORM_CALL_ID_CONTEXT_KEY]?: string;
};

function createTransformCallId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}

	return `call-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function ensureTransformCallId(context: TransformContext): TransformCallIdContext {
	if (typeof context[TRANSFORM_CALL_ID_CONTEXT_KEY] === "string") {
		return context as TransformCallIdContext;
	}

	return {
		...context,
		[TRANSFORM_CALL_ID_CONTEXT_KEY]: createTransformCallId(),
	};
}

function mergeContextPreservingCallId(
	base: TransformContext,
	patch: Partial<TransformContext>
): TransformCallIdContext {
	const merged: TransformCallIdContext = {
		...base,
		...patch,
	};

	const baseCallId = base[TRANSFORM_CALL_ID_CONTEXT_KEY];
	if (typeof baseCallId === "string") {
		merged[TRANSFORM_CALL_ID_CONTEXT_KEY] = baseCallId;
	}

	return ensureTransformCallId(merged);
}

export type TransformNextInput<
	TArgs extends readonly unknown[],
	TContext extends TransformContext = TransformContext,
	TResult = undefined,
> = {
	args?: TArgs;
	context?: Partial<TContext>;
	/**
	 * When provided, the remaining transforms in the pipeline still
	 * execute but the actual method (or RPC call) is never invoked.
	 * The value is used as if the method returned it, so downstream
	 * transforms (e.g. a codec) can process it normally.
	 *
	 * The type of `result` is captured: `next({ result: X })` returns
	 * `Promise<TransformResult<X>>` instead of `Promise<TransformResult<TPrev>>`.
	 */
	result?: TResult;
};

// ---------------------------------------------------------------------------
// Internal wire envelope
// ---------------------------------------------------------------------------

const ENVELOPE_BRAND = "__doRpcTransforms" as const;

type RpcEnvelope = {
	[ENVELOPE_BRAND]: 1;
	args: unknown[];
	context: TransformContext;
};

function encodeEnvelope(
	args: unknown[],
	context: TransformContext
): [RpcEnvelope] {
	return [{ [ENVELOPE_BRAND]: 1, args, context }];
}

function decodeEnvelope(
	rawArgs: unknown[]
): { args: unknown[]; context: TransformContext } | undefined {
	if (
		rawArgs.length === 1 &&
		typeof rawArgs[0] === "object" &&
		rawArgs[0] !== null &&
		ENVELOPE_BRAND in rawArgs[0] &&
		(rawArgs[0] as Record<string, unknown>)[ENVELOPE_BRAND] === 1
	) {
		const envelope = rawArgs[0] as RpcEnvelope;
		return {
			args: envelope.args,
			context: envelope.context,
		};
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// OutputFn — type-level function for per-method return type transformation
// ---------------------------------------------------------------------------

type IsAnyOrUnknown<T> = 0 extends 1 & T
	? true // T is any
	: unknown extends T
		? true // T is unknown
		: false;

// ---------------------------------------------------------------------------
// TransformResult — phantom brand for next() return values
//
// At runtime, next() returns the raw value.  The brand exists only at
// the type level so that `.with()` can distinguish passthrough
// (`return next()`) from explicit override (`return someValue`).
//
//   - TransformResult<T> is assignable to T (intersection ⊆ each member)
//   - T is NOT assignable to TransformResult<T> (missing required brand)
//   - UnwrapTransformResult strips the brand (distributes over unions)
// ---------------------------------------------------------------------------

declare const transformResultBrand: unique symbol;

type TransformResult<T> =
	IsAnyOrUnknown<T> extends true
		? T
		: T & { readonly [transformResultBrand]: never };

type UnwrapTransformResult<T> = 0 extends 1 & T // T is any
	? T
	: T extends { readonly [transformResultBrand]: never }
		? T extends infer U & { readonly [transformResultBrand]: never }
			? U
			: T
		: T;

declare const outputFnBrand: unique symbol;

/**
 * A type-level function ("TypeLambda") for transforming per-method
 * return types.  Extend this interface to define how a transform
 * reshapes each method's return type.
 *
 * The library applies it per-method: given a method returning `R`,
 * `(YourFn & { readonly In: R })["Out"]` produces the new return type.
 *
 * @example
 * ```ts
 * // Widen the error channel of Result-returning methods:
 * interface AddBusyError extends OutputFn {
 *   readonly Out: this["In"] extends Result<infer T, infer E>
 *     ? Result<T, E | MethodBusyError>
 *     : this["In"]
 * }
 *
 * const singleFlight = createTransform<object, {}, {}, AddBusyError>()
 * // For increment(): Result<number, never>  →  Result<number, MethodBusyError>
 * // For getName(): string  →  string (unchanged, not a Result)
 * ```
 */
export interface OutputFn {
	readonly [outputFnBrand]: never;
	readonly In: unknown;
	readonly Out: unknown;
}

type UnknownCalleePassthrough = never;

/**
 * Applies an `OutputFn` type-level function to a concrete type `R`.
 */
type ApplyOutputFn<F extends OutputFn, R> = (F & { readonly In: R })["Out"];

/**
 * Detects whether `T` extends `OutputFn`.
 */
type IsOutputFn<T> = T extends OutputFn ? true : false;

// ---------------------------------------------------------------------------
// Output accumulation — ComputeOutput, OutputUnion, InlineCallerContext
// ---------------------------------------------------------------------------

/**
 * Compute the new accumulated output when a named transform with
 * `TIncoming` output is added to a chain whose current output is `TPrev`.
 *
 * - If TIncoming is `any` or `unknown` (passthrough), preserve TPrev.
 * - Otherwise, TIncoming takes over.
 */
type ComputeOutput<TPrev, TIncoming> =
	IsAnyOrUnknown<TIncoming> extends true ? TPrev : TIncoming;

/**
 * Union of all public async method return types (unwrapped from Promise).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MethodReturnUnion<TMethods extends object> = {
	[K in keyof PublicAsyncMethods<TMethods>]: PublicAsyncMethods<TMethods>[K] extends (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...args: any[]
	) => Promise<infer R>
		? R
		: never;
}[keyof PublicAsyncMethods<TMethods>];

/**
 * Collapses per-method output types to a union for use inside handler
 * bodies.  When `TOutput` is an `OutputFn`, each method's return type
 * is individually transformed and the results are unioned.  When
 * `TOutput` is `unknown`, falls back to the union of original method
 * return types.  When `TOutput` is a concrete type, returns it directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OutputUnion<TMethods extends object, TOutput> = unknown extends TOutput
	? MethodReturnUnion<TMethods>
	: true extends IsOutputFn<TOutput>
		? {
				[K in keyof PublicAsyncMethods<TMethods>]: PublicAsyncMethods<TMethods>[K] extends (
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					...args: any[]
				) => Promise<infer R>
					? ApplyOutputFn<Extract<TOutput, OutputFn>, R>
					: never;
			}[keyof PublicAsyncMethods<TMethods>]
		: TOutput;

/**
 * Caller context for inline `.with()` handlers.  Unlike `CallerContext`,
 * this is NOT generic over `K` — the handler handles all methods, so
 * `method` is a union of all method names and `args` is `unknown[]`.
 *
 * In exchange, TypeScript can infer the handler's return type `TReturn`
 * which is used to compute the new accumulated output.
 *
 * `next()` is generic over `TResult` — calling `next({ result: X })`
 * infers `TResult = X` and returns `Promise<TransformResult<X>>`.
 */
export type InlineCallerContext<
	TStub extends object,
	TMethods extends object,
	TContext extends TransformContext = TransformContext,
	TPrevOutput = unknown,
> = {
	stub: TStub;
	method: CallableKey<TStub>;
	id: unknown;
	args: unknown[];
	context: TContext;
	next: <TResult = undefined>(
		input?: TransformNextInput<unknown[], TContext, TResult>
	) => Promise<
		TransformResult<
			TResult extends undefined ? OutputUnion<TMethods, TPrevOutput> : TResult
		>
	>;
};

/**
 * Accumulates the output type from a tuple of transforms (for
 * `.transforms([a, b, c])` on the builder).  Walks the tuple
 * right-to-left: the last element is closest to the wire, so
 * the first transform with a declared output (non-any/unknown)
 * determines what `next()` returns for the new handler.
 *
 * When no transform in the chain declares an output, falls back
 * to `TDefault`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AccumulateChainOutput<
	TTransforms,
	TDefault = unknown,
> = TTransforms extends readonly [
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	...infer Rest extends readonly CallerTransform<any, any, any, any>[],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	infer Last extends CallerTransform<any, any, any, any>,
]
	? IsAnyOrUnknown<TransformOutput<Last>> extends true
		? AccumulateChainOutput<Rest, TDefault>
		: TransformOutput<Last>
	: TDefault;

// ---------------------------------------------------------------------------
// Caller-side types
// ---------------------------------------------------------------------------

export type CallerContext<
	TStub extends object,
	K extends CallableKey<TStub>,
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = {
	stub: TStub;
	method: K;
	id: unknown;
	args: Parameters<CallableMethod<TStub, K>>;
	context: TContext;
	next: <TResult = undefined>(
		input?: TransformNextInput<
			Parameters<CallableMethod<TStub, K>>,
			TContext,
			TResult
		>
	) => Promise<TransformResult<TResult extends undefined ? TOutput : TResult>>;
};

export type CallerHandler<
	TStub extends object,
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = <K extends CallableKey<TStub>>(
	context: CallerContext<TStub, K, TContext, TOutput>
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Callee-side types
// ---------------------------------------------------------------------------

export type CalleeContext<
	TInstance extends object,
	K extends AnyCallableKey<TInstance>,
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = {
	instance: TInstance;
	method: K;
	id: unknown;
	args: K extends CallableKey<TInstance>
		? Parameters<CallableMethod<TInstance, K>>
		: unknown[];
	context: TContext;
	state: unknown;
	env: unknown;
	next: <TResult = undefined>(
		input?: TransformNextInput<
			K extends CallableKey<TInstance>
				? Parameters<CallableMethod<TInstance, K>>
				: unknown[],
			TContext,
			TResult
		>
	) => Promise<
		TransformResult<
			TResult extends undefined
				? unknown extends TOutput
					? UnknownCalleePassthrough
					: TOutput
				: TResult
		>
	>;
};

export type CalleeHandler<
	TInstance extends object,
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = <K extends AnyCallableKey<TInstance>>(
	context: CalleeContext<TInstance, K, TContext, TOutput>
) => Promise<unknown>;

export type CalleeContextPipelineMeta<TInstance extends object> = {
	instance: TInstance;
	method: CallableKey<TInstance>;
	args: unknown[];
	state: unknown;
	env: unknown;
};

export interface TransformContextPipeline<
	TContext extends TransformContext = TransformContext,
	TInstance extends object = object,
> {
	addTransformContext(
		context: TContext,
		meta: CalleeContextPipelineMeta<TInstance>
	): Promise<Partial<TContext> | void> | Partial<TContext> | void;
}

// ---------------------------------------------------------------------------
// Transform object types
// ---------------------------------------------------------------------------

declare const contractSymbol: unique symbol;
declare const outputSymbol: unique symbol;

export type CallerTransform<
	TStub extends object,
	TContract extends object = {},
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = {
	onCall: CallerHandler<TStub, TContext, TOutput>;
	readonly [contractSymbol]?: TContract;
	readonly [outputSymbol]?: TOutput;
};

export type CalleeTransform<
	TInstance extends object,
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = {
	onReceive: CalleeHandler<TInstance, TContext>;
 	readonly [outputSymbol]?: TOutput;
} & Partial<TransformContextPipeline<TContext, TInstance>>;

export type FullTransform<
	TStub extends object,
	TContract extends object = {},
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
> = CallerTransform<TStub, TContract, TContext, TOutput> &
	CalleeTransform<TStub, TContext, TOutput>;

// ---------------------------------------------------------------------------
// TransformedStub (caller-side wrapper)
// ---------------------------------------------------------------------------

/**
 * A wrapped `DurableObjectStub` with `.with()` chaining and `.unwrap()`.
 *
 * `TStub` is the raw stub type (e.g. `DurableObjectStub<MyDO>`).
 * `TMethods` is the DO class type (e.g. `MyDO`) whose public async
 * method signatures are presented directly — without RPC wrapping —
 * so that return types like `Result<A, E>` flow through unchanged.
 *
 * `TPrevOutput` is the accumulated output type from all inner `.with()`
 * calls (the transforms that run *after* this point in the pipeline,
 * closer to the wire).  Each `.with()` can change it:
 *
 * - Named transforms: `ComputeOutput<TPrev, TIncoming>` — passthrough
 *   transforms preserve `TPrev`, transforms with declared output override.
 * - Inline handlers: `UnwrapTransformResult<TReturn>` — the handler's
 *   actual return type (with `TransformResult` brand stripped) becomes
 *   the new accumulated output.
 *
 * `StubMethods` reads `TPrevOutput` to determine method return types:
 * `unknown` → original signatures, `OutputFn` → per-method, concrete → blanket.
 *
 * For mock namespaces (unit tests), `TMethods` defaults to `TStub`
 * since there is no RPC wrapping to strip.
 */
export type TransformedStub<
	TStub extends object,
	TMethods extends object = TStub,
	TContract extends object = {},
	TPrevOutput = unknown,
> = StubMethods<TMethods, TPrevOutput> & {
	/**
	 * Overload 1: Inline handler function.
	 * TypeScript infers `TReturn` from the handler's return expression.
	 * `UnwrapTransformResult` strips the `TransformResult` brand:
	 *   - `return next()` → passthrough, preserves `TPrevOutput`
	 *   - `return next({ result: X })` → `X`
	 *   - `return someValue` → `typeof someValue`
	 *   - mixed branches → union of all possibilities
	 *
	 * Listed first so TypeScript tries it before the named-transform
	 * overload.  Named transforms have `onCall` which doesn't match
	 * the single-argument function signature, so they fall through.
	 */
	with<TReturn>(
		handler: (
			ctx: InlineCallerContext<TStub, TMethods, TransformContext, TPrevOutput>
		) => Promise<TReturn>
	): TransformedStub<
		TStub,
		TMethods,
		TContract,
		UnwrapTransformResult<TReturn>
	>;

	/**
	 * Overload 2: Named transform (has `onCall` property).
	 * Output is computed via `ComputeOutput<TPrev, TIncoming>`.
	 */
	with<
		TIncomingContract extends object,
		TContext extends TransformContext = TransformContext,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		TIncomingOutput = any,
	>(
		transform: CallerTransform<
			TStub,
			TIncomingContract,
			TContext,
			TIncomingOutput
		> &
			EnsureCompatibleContracts<TContract, TIncomingContract>
	): TransformedStub<
		TStub,
		TMethods,
		MergeContractsOrNever<TContract, TIncomingContract>,
		ComputeOutput<TPrevOutput, TIncomingOutput>
	>;

	unwrap(): TStub;
};

// ---------------------------------------------------------------------------
// Transform type extraction helpers
// ---------------------------------------------------------------------------

/**
 * Detects whether a type is a transform (has `onCall` from a CallerTransform).
 */
type IsTransform<T> = T extends { onCall: CallerHandler<infer _S, infer _C> }
	? true
	: false;

/**
 * Extracts the stub type from a CallerTransform.
 *
 * ```ts
 * type S = TransformStub<typeof myCodec>; // => MyDO
 * ```
 */
export type TransformStub<T> =
	T extends CallerTransform<infer TStub, infer _C, infer _Ctx, infer _O>
		? TStub
		: never;

/**
 * Extracts the output type from a CallerTransform.
 *
 * ```ts
 * type O = TransformOutput<typeof myCodec>; // => Result<Ok, AppError>
 * ```
 */
export type TransformOutput<T> = T extends {
	readonly [K in typeof outputSymbol]?: infer TOutput;
}
	? unknown extends TOutput
		? unknown
		: TOutput
	: unknown;

/**
 * Extracts the contract type from a CallerTransform.
 */
export type TransformContract<T> = T extends {
	readonly [K in typeof contractSymbol]?: infer TContract;
}
	? TContract extends object
		? TContract
		: {}
	: {};

/**
 * Extracts the transform context type from a CallerTransform.
 */
export type TransformContextOf<T> =
	T extends CallerTransform<infer _S, infer _C, infer TCtx, infer _O>
		? TCtx
		: TransformContext;

type MethodOutputMap<TInstance extends object> = Partial<
	Record<keyof PublicAsyncMethods<TInstance> & string, unknown>
>;

type ApplyDOOutput<R, TOutput> = unknown extends TOutput
	? R
	: true extends IsOutputFn<TOutput>
		? ApplyOutputFn<Extract<TOutput, OutputFn>, R>
		: TOutput;

type ApplyMethodAndClassOutput<
	R,
	TClassOutput,
	TMethodOutput,
> = ApplyDOOutput<ApplyDOOutput<R, TClassOutput>, TMethodOutput>;

type RemapDOInstanceMethods<
	TInstance extends object,
	TClassOutput,
	TMethodOutputs extends MethodOutputMap<TInstance>,
> = Omit<TInstance, keyof PublicAsyncMethods<TInstance>> & {
	[K in keyof PublicAsyncMethods<TInstance>]: PublicAsyncMethods<TInstance>[K] extends (
		...args: infer A
	) => Promise<infer R>
		? (...args: A) => Promise<
				ApplyMethodAndClassOutput<
					R,
					TClassOutput,
					K extends keyof TMethodOutputs ? TMethodOutputs[K] : unknown
				>
		  >
		: PublicAsyncMethods<TInstance>[K];
};

type MergeMethodOutput<
	TInstance extends object,
	TMethodOutputs extends MethodOutputMap<TInstance>,
	K extends keyof PublicAsyncMethods<TInstance> & string,
	TIncoming,
> = MethodOutputMap<TInstance> & Omit<TMethodOutputs, K> & {
	[K2 in K]: K2 extends keyof TMethodOutputs
		? ComputeOutput<TMethodOutputs[K2], TIncoming>
		: TIncoming;
};

type AugmentedDOClass<
	TClass extends abstract new (...args: any[]) => object,
	TClassOutput,
	TMethodOutputs extends MethodOutputMap<InstanceType<TClass>>,
> = (abstract new (
	...args: ConstructorParameters<TClass>
) => RemapDOInstanceMethods<InstanceType<TClass>, TClassOutput, TMethodOutputs>) &
	Omit<TClass, "prototype"> & {
		prototype: RemapDOInstanceMethods<
			InstanceType<TClass>,
			TClassOutput,
			TMethodOutputs
		>;
	};

type AccumulateCalleeChainOutput<
	TTransforms,
	TDefault = unknown,
> = TTransforms extends readonly [
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	...infer Rest extends readonly CalleeTransform<any, any, any>[],
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	infer Last extends CalleeTransform<any, any, any>,
]
	? IsAnyOrUnknown<TransformOutput<Last>> extends true
		? AccumulateCalleeChainOutput<Rest, TDefault>
		: TransformOutput<Last>
	: TDefault;

interface WidenOutputFn<TAdded> extends OutputFn {
	readonly Out: this["In"] | TAdded;
}

type StripUnknownCalleePassthrough<T> = Exclude<T, UnknownCalleePassthrough>;

type InferCalleeFactoryOutput<TFactory> = TFactory extends (
	...args: any[]
) => (...handlerArgs: any[]) => Promise<infer R>
	? [StripUnknownCalleePassthrough<UnwrapTransformResult<R>>] extends [never]
		? unknown
		: WidenOutputFn<StripUnknownCalleePassthrough<UnwrapTransformResult<R>>>
	: unknown;

// ---------------------------------------------------------------------------
// createTransform() builder
// ---------------------------------------------------------------------------

/**
 * `.caller()` and `.callee()` always take a factory function:
 *   (...params) => handler
 *
 * For no-param transforms, use a zero-arg factory:
 *   .caller(() => async ({ next }) => next())
 *
 * For parameterized transforms:
 *   .caller((retries: number) => async ({ next }) => { ... })
 *
 * The result is always callable — call it with params to get the transform.
 *
 * When the first generic argument is a transform type (has `onCall`),
 * the stub, contract, context, and output types are extracted from it:
 *
 * ```ts
 * const metrics = createTransform<typeof codec>().caller(
 *   () => async ({ next }) => {
 *     const value = await next(); // typed as codec's output
 *     return value;
 *   }
 * )();
 * ```
 */

type TransformBuilder<
	TStub extends object,
	TContract extends object,
	TContext extends TransformContext,
	TOutput = unknown,
> = {
	callerParams<TCallerParams>(): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		TCallerParams,
		void,
		false,
		false
	>;
	calleeParams<TCalleeParams>(): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		void,
		TCalleeParams,
		false,
		false
	>;

	/**
	 * Declare predecessor transforms.  The accumulated output of the
	 * chain becomes the return type of `next()` inside the handler.
	 *
	 * ```ts
	 * const metricsFromCodec = createTransform<AppDO>()
	 *   .transforms([codec()])
	 *   .caller(() => async ({ next }) => {
	 *     const value = await next(); // typed as codec's output
	 *     return value;
	 *   })();
	 * ```
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	transforms<const T extends readonly CallerTransform<any, any, any, any>[]>(
		transforms: T
	): TransformBuilder<
		TStub,
		TContract,
		TContext,
		AccumulateChainOutput<T, TOutput>
	>;

	caller<TArgs extends unknown[]>(
		factory: (...args: TArgs) => CallerHandler<TStub, TContext, TOutput>
	): {
		(...args: TArgs): CallerTransform<TStub, TContract, TContext, TOutput>;
		callee<TFactory extends (...args: any[]) => CalleeHandler<TStub, TContext, TOutput>>(
			factory: TFactory
		): (...args: TArgs) => {
			(...calleeArgs: Parameters<TFactory>): CalleeTransform<
				TStub,
				TContext,
				ComputeOutput<TOutput, InferCalleeFactoryOutput<TFactory>>
			>;
		} & CallerTransform<TStub, TContract, TContext, TOutput>;
	};

	callee<TFactory extends (...args: any[]) => CalleeHandler<TStub, TContext, TOutput>>(
		factory: TFactory
	): {
		(...args: Parameters<TFactory>): CalleeTransform<
			TStub,
			TContext,
			ComputeOutput<TOutput, InferCalleeFactoryOutput<TFactory>>
		>;
		caller<TCallerArgs extends unknown[]>(
			factory: (...args: TCallerArgs) => CallerHandler<TStub, TContext, TOutput>
		): (...args: TCallerArgs) => {
			(...calleeArgs: Parameters<TFactory>): CalleeTransform<
				TStub,
				TContext,
				ComputeOutput<TOutput, InferCalleeFactoryOutput<TFactory>>
			>;
		} & CallerTransform<TStub, TContract, TContext, TOutput>;
	};
};

/**
 * Create a transform builder.
 *
 * Overload 1: `createTransform<typeof prevTransform>()`
 *   Build a transform whose stub, contract, context, and output types
 *   are inferred from a previous transform.  The output of the previous
 *   transform becomes the return type of `next()` in the new handler.
 *
 * Overload 2: `createTransform<TStub, TContract?, TContext?, TOutput?>()`
 *   Build a transform for a given stub/instance type.
 *   `TOutput` can be a concrete type (blanket override) or an `OutputFn`
 *   (per-method type-level function).
 */

// Overload 1: infer from a previous transform
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTransform<
	T extends CallerTransform<any, any, any, any>,
>(): TransformBuilder<
	TransformStub<T>,
	TransformContract<T> extends object ? TransformContract<T> : {},
	TransformContextOf<T> extends TransformContext
		? TransformContextOf<T>
		: TransformContext,
	TransformOutput<T>
>;

// Overload 2: plain stub type
export function createTransform<
	T extends object,
	TContract extends object = {},
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
>(): TransformBuilder<T, TContract, TContext, TOutput>;

// Implementation
export function createTransform(): // eslint-disable-next-line @typescript-eslint/no-explicit-any
TransformBuilder<any, any, any, any> {
	// The runtime implementation is type-erased — all the interesting
	// type work happens in the function signature and TransformBuilder.
	// We use `any` internally to avoid fighting conditional types that
	// TypeScript can't resolve inside the body.

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const builder: any = {
		callerParams() {
			return createSplitTransformBuilder();
		},
		calleeParams() {
			return createSplitTransformBuilder();
		},

		// .transforms() is a type-only operation — at runtime it's a no-op
		// that returns the same builder.  The accumulated output type is
		// computed entirely at the type level.
		transforms() {
			return builder;
		},

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		caller(callerFactory: (...args: any[]) => any) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const result = (...args: any[]) => {
				return { onCall: callerFactory(...args) };
			};

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			result.callee = (calleeFactory: (...cArgs: any[]) => any) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return (...callerArgs: any[]) => {
					const callerHandler = callerFactory(...callerArgs);
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const combined = (...calleeArgs: any[]) => {
						return { onReceive: calleeFactory(...calleeArgs) };
					};
					(combined as unknown as Record<string, unknown>).onCall =
						callerHandler;
					return combined;
				};
			};

			return result;
		},

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		callee(calleeFactory: (...args: any[]) => any) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const result = (...args: any[]) => {
				return { onReceive: calleeFactory(...args) };
			};

			// Use Object.defineProperty because strict mode functions have a
			// non-configurable `.caller` accessor that throws on direct assignment.
			Object.defineProperty(result, "caller", {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				value: (callerFactory: (...cArgs: any[]) => any) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return (...callerArgs: any[]) => {
						const callerHandler = callerFactory(...callerArgs);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const combined = (...calleeArgs: any[]) => {
							return { onReceive: calleeFactory(...calleeArgs) };
						};
						(combined as unknown as Record<string, unknown>).onCall =
							callerHandler;
						return combined;
					};
				},
				writable: true,
				configurable: true,
			});

			return result;
		},
	};

	return builder;
}

type DefineTransformConfigArgs<TParams> = [TParams] extends [void]
	? []
	: [params: TParams];

type DefineDOTransformBuilder<
	TStub extends object,
	TContract extends object,
	TContext extends TransformContext,
	TOutput,
	TCallerParams,
	TCalleeParams,
	THasCaller extends boolean,
	THasCallee extends boolean,
> = {
	callerParams<TNextCallerParams>(): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		TNextCallerParams,
		TCalleeParams,
		THasCaller,
		THasCallee
	>;
	calleeParams<TNextCalleeParams>(): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		TCallerParams,
		TNextCalleeParams,
		THasCaller,
		THasCallee
	>;
	caller(
		factory: [TCallerParams] extends [void]
			? () => CallerHandler<TStub, TContext, TOutput>
			: (params: TCallerParams) => CallerHandler<TStub, TContext, TOutput>
	): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		TCallerParams,
		TCalleeParams,
		true,
		THasCallee
	>;
	callee(
		factory: [TCalleeParams] extends [void]
			? () => CalleeHandler<TStub, TContext>
			: (params: TCalleeParams) => CalleeHandler<TStub, TContext>
	): DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		TCallerParams,
		TCalleeParams,
		THasCaller,
		true
	>;
} & (THasCaller extends true
	? {
			callerConfig(
				...args: DefineTransformConfigArgs<TCallerParams>
			): CallerTransform<TStub, TContract, TContext, TOutput>;
		} & ([TCallerParams] extends [void]
			? CallerTransform<TStub, TContract, TContext, TOutput>
			: {})
	: {}) &
	(THasCallee extends true
		? {
				calleeConfig(
					...args: DefineTransformConfigArgs<TCalleeParams>
				): CalleeTransform<TStub, TContext, TOutput>;
			} & ([TCalleeParams] extends [void]
				? CalleeTransform<TStub, TContext, TOutput>
				: {})
		: {});

function createSplitTransformBuilder<
	TStub extends object,
	TContract extends object = {},
	TContext extends TransformContext = TransformContext,
	TOutput = unknown,
>(): DefineDOTransformBuilder<
	TStub,
	TContract,
	TContext,
	TOutput,
	void,
	void,
	false,
	false
> {
	let callerFactory:
		| (/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ((params: any) => CallerHandler<TStub, TContext, TOutput>))
		| undefined;
	let calleeFactory:
		| (/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ((params: any) => CalleeHandler<TStub, TContext>))
		| undefined;

	const invokeFactory = <TResult>(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		factory: ((params: any) => TResult) | undefined,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		args: any[]
	): TResult => {
		if (!factory) {
			throw new Error("[do-rpc-transforms] Missing transform factory");
		}
		return args.length === 0 ? factory(undefined) : factory(args[0]);
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const builder: any = {
		callerParams() {
			return builder;
		},
		calleeParams() {
			return builder;
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		caller(factory: (params: any) => CallerHandler<TStub, TContext, TOutput>) {
			callerFactory = factory;
			if (factory.length === 0) {
				builder.onCall = invokeFactory(callerFactory, []);
			}
			return builder;
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		callee(factory: (params: any) => CalleeHandler<TStub, TContext>) {
			calleeFactory = factory;
			if (factory.length === 0) {
				builder.onReceive = invokeFactory(calleeFactory, []);
			}
			return builder;
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		callerConfig(...args: any[]) {
			return {
				onCall: invokeFactory(callerFactory, args),
			};
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		calleeConfig(...args: any[]) {
			return {
				onReceive: invokeFactory(calleeFactory, args),
			};
		},
	};

	return builder as DefineDOTransformBuilder<
		TStub,
		TContract,
		TContext,
		TOutput,
		void,
		void,
		false,
		false
	>;
}

// ---------------------------------------------------------------------------
// Namespace proxy types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a DurableObjectNamespace — just enough for runtime
 * detection and type-level proxy generation.  We avoid importing from
 * `@cloudflare/workers-types` so the library stays self-contained at
 * runtime.
 */
type NamespaceLike<TStub extends object = object> = {
	newUniqueId(...args: unknown[]): unknown;
	idFromName(name: string): unknown;
	idFromString(id: string): unknown;
	get(id: unknown, ...rest: unknown[]): TStub;
	getByName?(name: string, ...rest: unknown[]): TStub;
	getExisting?(id: unknown, ...rest: unknown[]): TStub;
	jurisdiction?(...args: unknown[]): NamespaceLike<TStub>;
};

/**
 * Extracts the stub type from a namespace-like object.
 * For `DurableObjectNamespace<T>` this yields `DurableObjectStub<T>`.
 * For our `NamespaceLike<TStub>` this yields `TStub`.
 */
type StubOf<TNamespace> = TNamespace extends {
	get(id: infer _Id, ...rest: infer _Rest): infer TStub;
}
	? TStub extends object
		? TStub
		: object
	: object;

// ---------------------------------------------------------------------------
// DO class extraction — recovers T from DurableObjectNamespace<T>
// ---------------------------------------------------------------------------

/**
 * Extracts the DO class type `T` from a namespace.
 *
 * For `DurableObjectNamespace<MyDO>`, TypeScript can infer `T`
 * directly via conditional type inference on the abstract class's
 * generic parameter.  For plain mock namespaces (unit tests), the
 * extraction falls back to `StubOf<N>` — the raw return type of
 * `.get()`, which already has the correct (unwrapped) method types.
 *
 * This requires `@cloudflare/workers-types` to be in the compilation
 * context (which it always is in real Workers projects).
 */
type ExtractDOClass<N> =
	N extends DurableObjectNamespace<infer T>
		? T extends object
			? T
			: StubOf<N>
		: StubOf<N>;

/**
 * Keys of public async methods on a type, excluding DurableObject
 * lifecycle methods, protected members, constructor, symbols, and
 * brand properties (`never`-typed keys like `__DURABLE_OBJECT_BRAND`).
 *
 * The `[T[K]] extends [never]` guard (wrapped to prevent distribution)
 * rejects brand properties whose type is `never`.  Without this,
 * `never extends (...args) => Promise<unknown>` evaluates to `true`
 * (bottom type extends everything), polluting `MethodReturnUnion`
 * with `unknown`.
 */
type AsyncMethodKeys<T extends object> = {
	[K in keyof T]-?: K extends string
		? [T[K]] extends [never]
			? never
			: T[K] extends (...args: never[]) => Promise<unknown>
				? K
				: never
		: never;
}[keyof T];

/**
 * DurableObject base class methods and protected members that should
 * NOT appear on the transformed stub's call surface.
 */
type DOBaseKeys =
	| "alarm"
	| "fetch"
	| "webSocketMessage"
	| "webSocketClose"
	| "webSocketError"
	| "ctx"
	| "env";

/**
 * Picks only the public async methods from `T` (the DO class),
 * excluding lifecycle hooks and protected members inherited from
 * the `DurableObject` base class.
 */
type PublicAsyncMethods<T extends object> = Pick<
	T,
	Exclude<AsyncMethodKeys<T>, DOBaseKeys>
>;

// ---------------------------------------------------------------------------
// Per-method return type override via StubMethods
//
// Three modes based on TOutput:
//
// 1. `unknown` (no TOutput declared) → original signatures preserved
// 2. `OutputFn` subtype → per-method: ApplyOutputFn<TOutput, R>
// 3. Concrete type → blanket override: all methods return Promise<TOutput>
// ---------------------------------------------------------------------------

/**
 * Maps public async methods, applying `TOutput` to their return types.
 *
 * - When `TOutput` is `unknown`, falls back to original signatures.
 * - When `TOutput extends OutputFn`, each method's `Promise<R>` return
 *   becomes `Promise<ApplyOutputFn<TOutput, R>>` — the user's type-level
 *   function transforms each method individually.
 * - Otherwise, all methods get a blanket `Promise<TOutput>`.
 */
type StubMethods<TMethods extends object, TOutput> = unknown extends TOutput
	? PublicAsyncMethods<TMethods>
	: true extends IsOutputFn<TOutput>
		? {
				[K in keyof PublicAsyncMethods<TMethods>]: PublicAsyncMethods<TMethods>[K] extends (
					...args: infer A
				) => Promise<infer R>
					? (
							...args: A
						) => Promise<ApplyOutputFn<Extract<TOutput, OutputFn>, R>>
					: PublicAsyncMethods<TMethods>[K];
			}
		: {
				[K in keyof PublicAsyncMethods<TMethods>]: PublicAsyncMethods<TMethods>[K] extends (
					...args: infer A
				) => Promise<unknown>
					? (...args: A) => Promise<TOutput>
					: PublicAsyncMethods<TMethods>[K];
			};

/**
 * A wrapped DurableObjectNamespace where `.get()`, `.getByName()`, and
 * `.getExisting()` return `TransformedStub`s, and `.jurisdiction()`
 * returns another `TransformedNamespace`.
 *
 * `TNamespace` is the original namespace type (e.g.
 * `DurableObjectNamespace<CounterDO>`) so we can carry the full shape
 * (parameter types, return types) through the proxy.
 *
 * `ExtractDOClass<TNamespace>` recovers the DO class `T` from the
 * namespace so that `TransformedStub` presents `T`'s native method
 * signatures — without Rpc.Provider wrapping.
 */
export type TransformedNamespace<
	TNamespace extends object,
	TContract extends object = {},
> = {
	[K in keyof TNamespace]: K extends "get" | "getByName" | "getExisting"
		? TNamespace[K] extends (...args: infer A) => infer _R
			? (
					...args: A
				) => TransformedStub<
					StubOf<TNamespace>,
					ExtractDOClass<TNamespace>,
					TContract
				>
			: TNamespace[K]
		: K extends "jurisdiction"
			? TNamespace[K] extends (...args: infer A) => infer _R
				? (...args: A) => TransformedNamespace<TNamespace, TContract>
				: TNamespace[K]
			: TNamespace[K];
};

// ---------------------------------------------------------------------------
// withTransforms (caller-side) — wraps a DurableObjectNamespace
// ---------------------------------------------------------------------------

/**
 * Wrap a `DurableObjectNamespace` so that `.get()` / `.getByName()` /
 * `.getExisting()` return stubs with `.with()` chaining built in.
 *
 * ```ts
 * const MY_DO = withTransforms(env.MY_DO);
 * const stub = MY_DO.get(id).with(retry(3)).with(observability());
 * await stub.increment(1);
 * ```
 */
export function withTransforms<TNamespace extends NamespaceLike>(
	namespace: TNamespace
): TransformedNamespace<TNamespace, {}> {
	return createWrappedNamespace(namespace, []);
}

/**
 * Creates a proxy around a DurableObjectNamespace that wraps stubs
 * returned by `.get()`, `.getByName()`, and `.getExisting()` with
 * the transform pipeline.
 */
function createWrappedNamespace(
	namespace: NamespaceLike,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	transforms: Array<CallerTransform<object, object, any>>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
	const stubMethods = new Set(["get", "getByName", "getExisting"]);

	return new Proxy(namespace as object, {
		get(target, property, _receiver) {
			if (property === "jurisdiction") {
				return (...args: unknown[]) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const inner = (target as any)[property](...args) as NamespaceLike;
					return createWrappedNamespace(inner, transforms);
				};
			}

			if (typeof property === "string" && stubMethods.has(property)) {
				return (...args: unknown[]) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const rawStub = (target as any)[property](...args) as object;
					return createWrappedStub(rawStub, transforms);
				};
			}

			// For pass-through properties (idFromName, idFromString,
			// newUniqueId, etc.), bind to the original target so workerd
			// native objects get the correct `this`.
			const value = Reflect.get(target, property);
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
	});
}

function createWrappedStub<TStub extends object, TContract extends object>(
	stub: TStub,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	transforms: Array<CallerTransform<TStub, object, any>>
): TransformedStub<TStub, TContract> {
	const proxy = new Proxy(stub as object, {
		get(target, property, _receiver) {
			if (property === "with") {
				return <
					TIncomingContract extends object,
					TContext extends TransformContext = TransformContext,
				>(
					transformOrHandler:
						| CallerTransform<TStub, TIncomingContract, TContext>
						| CallerHandler<TStub, TContext>
				) => {
					// Check for `onCall` first: a combined caller+callee transform
					// from `.caller().callee()` is a callable function with `onCall`
					// attached.  We must not treat it as a bare handler.
					const transform: CallerTransform<TStub, TIncomingContract, TContext> =
						typeof transformOrHandler === "function" &&
						!("onCall" in transformOrHandler)
							? { onCall: transformOrHandler }
							: (transformOrHandler as CallerTransform<
									TStub,
									TIncomingContract,
									TContext
								>);
					return createWrappedStub<
						TStub,
						MergeContractsOrNever<TContract, TIncomingContract>
					>(stub, [...transforms, transform]);
				};
			}

			if (property === "unwrap") {
				return () => stub;
			}

			const value = Reflect.get(target, property);
			if (typeof property !== "string" || typeof value !== "function") {
				return value;
			}

			return (...initialArgs: unknown[]) => {
				const methodName = property as CallableKey<TStub>;
				const id = readStubId(stub);
				const callContext = ensureTransformCallId({});

				const run = (
					index: number,
					args: Parameters<CallableMethod<TStub, typeof methodName>>,
					ctx: TransformContext,
					shortCircuit?: unknown
				): Promise<unknown> => {
					const transform = transforms[index];
					if (transform === undefined) {
						// End of caller pipeline — if a previous transform
						// provided a result via next({ result }), use it
						// instead of making the RPC call.
						if (shortCircuit !== undefined) {
							return Promise.resolve(shortCircuit);
						}

						const shouldSendContext = Object.keys(ctx).some(
							(key) => key !== TRANSFORM_CALL_ID_CONTEXT_KEY
						);
						// Call the method directly.
						// If the context carries user metadata, wrap in an
						// envelope so the callee side can extract it.
						if (shouldSendContext) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							return (target as any)[property](
								...(encodeEnvelope(
									args as unknown[],
									ctx
								) as unknown as Parameters<
									CallableMethod<TStub, typeof methodName>
								>)
							);
						}
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						return (target as any)[property](...(args as unknown[]));
					}

					return Promise.resolve(
						transform.onCall({
							stub,
							method: methodName,
							id,
							args,
							context: ctx,
							// The runtime `run` returns Promise<unknown> but the
							// type-level `next()` returns Promise<TransformResult<...>>.
							// The TransformResult brand is phantom (type-only), so
							// the raw value IS the correct runtime return.
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							next: ((input: any) => {
								const nextArgs = input?.args ?? args;
								const nextCtx = input?.context
									? mergeContextPreservingCallId(ctx, input.context)
									: ctx;
								const nextResult =
									input?.result !== undefined ? input.result : shortCircuit;
								return run(index + 1, nextArgs, nextCtx, nextResult);
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
							}) as any,
						})
					);
				};

				return run(
					0,
					initialArgs as Parameters<CallableMethod<TStub, typeof methodName>>,
					callContext
				) as ReturnType<CallableMethod<TStub, typeof methodName>>;
			};
		},
	});

	return proxy as TransformedStub<TStub, TContract>;
}

function readStubId(stub: object | null | undefined): unknown {
	if (stub == null || !("id" in stub)) {
		return undefined;
	}

	return (stub as { id?: unknown }).id;
}

// ---------------------------------------------------------------------------
// Callee-side: buildCalleeDispatch + withCalleeTransforms
// ---------------------------------------------------------------------------

export type CalleeTransformOptions = {
	state?: unknown;
	env?: unknown;
};

/**
 * Creates a dispatch function that runs the callee transform pipeline
 * and then delegates to the original method.
 *
 * `originalMethods` maps method names to their **original** implementations
 * (captured before any patching).  The dispatch function calls the original
 * so that patched wrappers on the prototype don't cause infinite loops.
 */
function buildCalleeDispatch<TInstance extends object>(
	resolveTransforms: (
		instance: TInstance,
		methodName: string
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	) => Array<CalleeTransform<TInstance, any>>,
	originalMethods: Map<string, Function>,
	options?: CalleeTransformOptions
): (
	this: TInstance,
	methodName: string,
	rawArgs: unknown[],
	context: TransformContext
) => Promise<unknown> {
	async function applyContextPipeline(
		self: TInstance,
		method: CallableKey<TInstance>,
		args: unknown[],
		transforms: Array<CalleeTransform<TInstance, any>>,
		initialContext: TransformContext,
		state: unknown,
		env: unknown
	): Promise<TransformContext> {
		let nextContext: TransformContext = ensureTransformCallId({
			...initialContext,
		});

		const pipeline: Array<
			Partial<TransformContextPipeline<TransformContext, TInstance>>
		> = [
			self as unknown as Partial<
				TransformContextPipeline<TransformContext, TInstance>
			>,
			...transforms,
		];

		for (const contributor of pipeline) {
			const addContext = contributor.addTransformContext;
			if (typeof addContext !== "function") {
				continue;
			}

			const callableAddContext =
				contributor === self
					? getDecoratedOriginalMethod(
							(self as { constructor: Function }).constructor,
							"addTransformContext"
					  ) ?? addContext
					: addContext;

			const added = await callableAddContext.call(
				contributor,
				nextContext,
				{
					instance: self,
					method,
					args,
					state,
					env,
				}
			);

			if (added && typeof added === "object") {
				nextContext = mergeContextPreservingCallId(nextContext, added);
			}
		}

		return nextContext;
	}

	return function dispatchHandler(
		this: TInstance,
		methodName: string,
		rawArgs: unknown[],
		context: TransformContext
	): Promise<unknown> {
		const self = this;
		const key = methodName as CallableKey<TInstance>;
		const originalMethod = originalMethods.get(methodName);
		const transforms = resolveTransforms(self, methodName);

		if (!originalMethod) {
			throw new Error(`[do-rpc-transforms] Unknown method: ${methodName}`);
		}

		const state = options?.state ?? (self as Record<string, unknown>).ctx;
		const env = options?.env ?? (self as Record<string, unknown>).env;

		const id = readStubId(self) ?? readStubId(state as object);

		const run = (
			index: number,
			args: Parameters<CallableMethod<TInstance, typeof key>>,
			ctx: TransformContext,
			shortCircuit?: unknown
		): Promise<unknown> => {
			const transform = transforms[index];
			if (transform === undefined) {
				// End of pipeline — if a previous transform provided a
				// result via next({ result }), use it instead of calling
				// the actual method.
				if (shortCircuit !== undefined) {
					return Promise.resolve(shortCircuit);
				}
				return originalMethod.apply(self, args) as Promise<unknown>;
			}

			return Promise.resolve(
				(transform.onReceive as any)({
					instance: self,
					method: key,
					id,
					args,
					context: ctx,
					state,
					env,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					next: ((input: any) => {
						const nextArgs = input?.args ?? args;
						const nextCtx = input?.context
							? mergeContextPreservingCallId(ctx, input.context)
							: ctx;
						const nextResult =
							input?.result !== undefined ? input.result : shortCircuit;
						return run(index + 1, nextArgs, nextCtx, nextResult);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
					}) as any,
				})
			);
		};

		const rawMethodArgs = rawArgs as Parameters<CallableMethod<TInstance, typeof key>>;
		const callContext = ensureTransformCallId(context ?? {});

		return applyContextPipeline(
			self,
			key,
			rawArgs,
			transforms,
			callContext,
			state,
			env
		).then((enrichedContext) => run(0, rawMethodArgs, enrichedContext));
	};
}

/**
 * Collects original method references from an instance and its prototype
 * chain, before any patching occurs.
 */
function collectOriginalMethods(instance: object): Map<string, Function> {
	const methods = new Map<string, Function>();
	const seen = new Set<string>();

	// Own methods (plain objects)
	for (const key of Object.getOwnPropertyNames(instance)) {
		if (key === "constructor") {
			continue;
		}
		const value = (instance as Record<string, unknown>)[key];
		if (typeof value === "function") {
			methods.set(key, value as Function);
			seen.add(key);
		}
	}

	// Prototype methods (class instances)
	let proto: object | null = Object.getPrototypeOf(instance) as object;
	while (proto !== null && proto !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (key === "constructor" || seen.has(key)) {
				continue;
			}
			const descriptor = Object.getOwnPropertyDescriptor(proto, key);
			if (descriptor && typeof descriptor.value === "function") {
				methods.set(key, descriptor.value as Function);
				seen.add(key);
			}
		}
		proto = Object.getPrototypeOf(proto) as object | null;
	}

	return methods;
}

/**
 * Wraps a DO instance so that every async method call goes through
 * the registered callee transforms before hitting the real method.
 *
 * For each method `foo` on the instance, a wrapper is installed that
 * delegates to an internal dispatch function.  The dispatch function
 * runs the callee transform pipeline and calls the **original** `foo`
 * (captured before patching) at the end.
 *
 * Usage in a DO constructor:
 * ```ts
 * class MyDO extends DurableObject {
 *   constructor(state, env) {
 *     super(state, env);
 *     return withCalleeTransforms(this, [logging()], { state, env });
 *   }
 * }
 * ```
 */
export function withCalleeTransforms<TInstance extends object>(
	instance: TInstance,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	transforms: Array<CalleeTransform<TInstance, any>>,
	options?: CalleeTransformOptions
): TInstance {
	if (transforms.length === 0) {
		return instance;
	}

	const originalMethods = collectOriginalMethods(instance);
	const dispatch = buildCalleeDispatch<TInstance>(
		(_instance, _methodName) => transforms,
		originalMethods,
		options
	);

	// Patch own methods on the instance (plain objects in tests)
	originalMethods.forEach((_fn, key) => {
		if (Object.prototype.hasOwnProperty.call(instance, key)) {
			(instance as Record<string, unknown>)[key] = function (
				this: TInstance,
				...rawArgs: unknown[]
			) {
				const envelope = decodeEnvelope(rawArgs);
				const args = envelope ? envelope.args : rawArgs;
				const ctx: TransformContext = envelope?.context ?? {};
				return dispatch.call(this, key, args, ctx);
			};
		}
	});

	// Patch prototype methods via a shadow prototype so that workerd's
	// JSRPC dispatch (which reads from the prototype) goes through the
	// transform pipeline.
	const originalProto = Object.getPrototypeOf(instance) as object | null;
	if (originalProto !== null && originalProto !== Object.prototype) {
		const shadow = Object.create(originalProto) as Record<string, unknown>;
		let needsShadow = false;

		originalMethods.forEach((_fn, key) => {
			// Skip own methods (already patched above)
			if (Object.prototype.hasOwnProperty.call(instance, key)) {
				return;
			}
			shadow[key] = function (this: TInstance, ...rawArgs: unknown[]) {
				const envelope = decodeEnvelope(rawArgs);
				const args = envelope ? envelope.args : rawArgs;
				const ctx: TransformContext = envelope?.context ?? {};
				return dispatch.call(this, key, args, ctx);
			};
			needsShadow = true;
		});

		if (needsShadow) {
			Object.setPrototypeOf(instance, shadow);
		}
	}

	return instance;
}

// ---------------------------------------------------------------------------
// Class/method DO transform registration
// ---------------------------------------------------------------------------

const methodTransformsSymbol = Symbol.for("__doRpcTransforms_methodTransforms");
const classTransformsSymbol = Symbol.for("__doRpcTransforms_classTransforms");
const decoratedPatchedSymbol = Symbol.for("__doRpcTransforms_decoratorsPatched");
const decoratedOriginalMethodsSymbol = Symbol.for(
	"__doRpcTransforms_decoratorsOriginalMethods"
);

type MethodTransformRegistry = Map<string, Array<CalleeTransform<object>>>;

type ClassTransformRegistry = Array<CalleeTransform<object>>;

function readClassTransformRegistry(
	klass: Function
): ClassTransformRegistry | undefined {
	if (!Object.prototype.hasOwnProperty.call(klass, classTransformsSymbol)) {
		return undefined;
	}
	const rec = klass as unknown as Record<PropertyKey, unknown>;
	const value = rec[classTransformsSymbol];
	return Array.isArray(value) ? (value as ClassTransformRegistry) : undefined;
}

function getOrCreateClassTransformRegistry(klass: Function): ClassTransformRegistry {
	const existing = readClassTransformRegistry(klass);
	if (existing) {
		return existing;
	}

	const list: ClassTransformRegistry = [];
	Object.defineProperty(klass, classTransformsSymbol, {
		value: list,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return list;
}

function registerClassTransforms(
	klass: Function,
	transforms: Array<CalleeTransform<object>>
): void {
	const registry = getOrCreateClassTransformRegistry(klass);
	for (const transform of transforms) {
		if (!registry.includes(transform)) {
			registry.push(transform);
		}
	}
}

function readMethodTransformRegistry(
	prototype: object
): MethodTransformRegistry | undefined {
	if (!Object.prototype.hasOwnProperty.call(prototype, methodTransformsSymbol)) {
		return undefined;
	}
	const rec = prototype as Record<PropertyKey, unknown>;
	const value = rec[methodTransformsSymbol];
	return value instanceof Map ? (value as MethodTransformRegistry) : undefined;
}

function getOrCreateMethodTransformRegistry(
	prototype: object
): MethodTransformRegistry {
	const existing = readMethodTransformRegistry(prototype);
	if (existing) {
		return existing;
	}

	const map: MethodTransformRegistry = new Map();
	Object.defineProperty(prototype, methodTransformsSymbol, {
		value: map,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return map;
}

function registerMethodTransforms(
	target: object,
	propertyKey: string | symbol,
	transforms: Array<CalleeTransform<object>>
): void {
	if (typeof propertyKey !== "string") {
		throw new Error(
			"[do-rpc-transforms] useDOTransforms only supports string method names"
		);
	}

	const registry = getOrCreateMethodTransformRegistry(target);
	const existing = registry.get(propertyKey) ?? [];
	const merged = [...existing];

	for (const transform of transforms) {
		if (!merged.includes(transform)) {
			merged.push(transform);
		}
	}

	registry.set(propertyKey, merged);
}

export type DOTransformsBuilder<
	TClass extends abstract new (...args: any[]) => object,
	TClassOutput = unknown,
	TMethodOutputs extends MethodOutputMap<InstanceType<TClass>> = {},
> = {
	with<
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		TTransforms extends readonly CalleeTransform<any, any, any>[],
		TIncomingOutput = AccumulateCalleeChainOutput<TTransforms>,
	>(
		...transforms: TTransforms
	): DOTransformsBuilder<
		TClass,
		ComputeOutput<TClassOutput, TIncomingOutput>,
		TMethodOutputs
	>;
	method<K extends keyof PublicAsyncMethods<InstanceType<TClass>> & string>(
		methodName: K
	): {
		with<
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			TTransforms extends readonly CalleeTransform<any, any, any>[],
			TIncomingOutput = AccumulateCalleeChainOutput<TTransforms>,
		>(
			...transforms: TTransforms
		): DOTransformsBuilder<
			TClass,
			TClassOutput,
			MergeMethodOutput<
				InstanceType<TClass>,
				TMethodOutputs,
				K,
				TIncomingOutput
			>
		>;
	};
	done(): AugmentedDOClass<TClass, TClassOutput, TMethodOutputs>;
};

/**
 * Registers DO-side transforms with a fluent builder API.
 *
 * Usage:
 * ```ts
 * useDOTransforms(MyDO)
 *   .with(authGuard(), metrics())
 *   .method("createTodo")
 *   .with(rateLimit("createTodo"));
 * ```
 */
export function useDOTransforms<
	TClass extends abstract new (...args: any[]) => object,
>(klass: TClass): DOTransformsBuilder<TClass> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const builder: any = {
		with(...transforms: Array<CalleeTransform<object>>) {
			registerClassTransforms(klass, transforms);
			patchDecoratedClass(klass);
			return builder;
		},
		method(methodName: string) {
			return {
				with(...transforms: Array<CalleeTransform<object>>) {
					registerMethodTransforms(klass.prototype, methodName, transforms);
					patchDecoratedClass(klass);
					return builder;
				},
			};
		},
		done() {
			patchDecoratedClass(klass);
			return klass;
		},
	};

	return builder as DOTransformsBuilder<TClass>;
}

function collectDecoratedMethodTransforms(
	instance: object
): Map<string, Array<CalleeTransform<object>>> {
	const collected = new Map<string, Array<CalleeTransform<object>>>();
	const prototypes: object[] = [];

	let proto: object | null = Object.getPrototypeOf(instance) as object | null;
	while (proto !== null && proto !== Object.prototype) {
		prototypes.unshift(proto);
		proto = Object.getPrototypeOf(proto) as object | null;
	}

	for (const current of prototypes) {
		const registry = readMethodTransformRegistry(current);
		if (!registry) {
			continue;
		}

		for (const [methodName, transforms] of registry.entries()) {
			const existing = collected.get(methodName) ?? [];
			collected.set(methodName, [...existing, ...transforms]);
		}
	}

	return collected;
}

/**
	 * Collects class-level decorator transforms along the class hierarchy,
	 * base-first.
 */
function collectClassDecoratedTransforms(
	klass: Function
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Array<CalleeTransform<any>> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const chain: Array<Array<CalleeTransform<any>>> = [];

	let current: Function | null = klass;
	while (current !== null && current !== Function.prototype) {
		const decorated = readClassTransformRegistry(current);
		if (decorated && decorated.length > 0) {
			chain.unshift(decorated as Array<CalleeTransform<any>>);
		}

		current = Object.getPrototypeOf(current) as Function | null;
	}

	return chain.flat();
}

function getOrCreateDecoratedOriginalMethods(
	klass: Function
): Map<string, Function> {
	const classProto = klass.prototype as Record<PropertyKey, unknown>;
	const existing = classProto[decoratedOriginalMethodsSymbol];
	if (existing instanceof Map) {
		return existing as Map<string, Function>;
	}

	const originalMethods = new Map<string, Function>();
	Object.defineProperty(classProto, decoratedOriginalMethodsSymbol, {
		value: originalMethods,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return originalMethods;
}

function getDecoratedOriginalMethod(
	klass: Function,
	methodName: string
): Function | undefined {
	const classProto = klass.prototype as Record<PropertyKey, unknown>;
	const existing = classProto[decoratedOriginalMethodsSymbol];
	if (!(existing instanceof Map)) {
		return undefined;
	}

	return (existing as Map<string, Function>).get(methodName);
}

function patchDecoratedClass(klass: Function): void {
	const classProto = klass.prototype as Record<string, unknown>;
	if (!classProto || typeof classProto !== "object") {
		return;
	}

	const originalMethods = getOrCreateDecoratedOriginalMethods(klass);

	for (const key of Object.getOwnPropertyNames(classProto)) {
		if (key === "constructor") {
			continue;
		}

		const descriptor = Object.getOwnPropertyDescriptor(classProto, key);
		if (!descriptor || typeof descriptor.value !== "function") {
			continue;
		}

		if (!originalMethods.has(key)) {
			originalMethods.set(key, descriptor.value as Function);
		}
	}

	const dispatch = buildCalleeDispatch(
		(instance, methodName) => {
			const classTransforms = collectClassDecoratedTransforms(
				instance.constructor as Function
			) as Array<CalleeTransform<object>>;
			const methodTransforms = collectDecoratedMethodTransforms(instance);
			return [
				...classTransforms,
				...(methodTransforms.get(methodName) ?? []),
			] as Array<CalleeTransform<object, TransformContext>>;
		},
		originalMethods as Map<string, Function>
	);

	originalMethods.forEach((_fn, key) => {
		classProto[key] = function (this: object, ...rawArgs: unknown[]) {
			const envelope = decodeEnvelope(rawArgs);
			const args = envelope ? envelope.args : rawArgs;
			const ctx: TransformContext = envelope?.context ?? {};
			return dispatch.call(this, key, args, ctx);
		};
	});

	if (!(decoratedPatchedSymbol in classProto)) {
		Object.defineProperty(classProto, decoratedPatchedSymbol, {
			value: true,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}
}
