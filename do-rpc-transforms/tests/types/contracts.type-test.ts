import {
	createTransform,
	withCalleeTransforms,
	withTransforms,
} from "../../src";
import type {
	CalleeHandler,
	CallerHandler,
	OutputFn,
	TransformContextOf,
	TransformContract,
	TransformOutput,
	TransformStub,
} from "../../src";

type ExampleStub = {
	id: string;
	sum(a: number, b: number): Promise<number>;
	greet(name: string): Promise<string>;
};

const exampleStub: ExampleStub = {
	id: "id-1",
	async sum(a: number, b: number): Promise<number> {
		return a + b;
	},
	async greet(name: string): Promise<string> {
		return `hello ${name}`;
	},
};

const exampleNs = {
	newUniqueId: () => ({ toString: () => "mock-id", name: "mock" }),
	idFromName: (name: string) => ({ toString: () => name, name }),
	idFromString: (id: string) => ({ toString: () => id, name: id }),
	get: (_id: unknown): ExampleStub => exampleStub,
};

// ---------------------------------------------------------------------------
// Caller-side: inline handler via factory
// ---------------------------------------------------------------------------

const traceCallerInline = createTransform<ExampleStub>().caller(
	() =>
		async ({ next }) => {
			return next();
		}
)();

// ---------------------------------------------------------------------------
// Caller-side: parameterized (plain function returning a transform)
// ---------------------------------------------------------------------------

function retry(retries: number) {
	return createTransform<ExampleStub>().caller(() => async ({ next }) => {
		let attempts = 0;
		while (true) {
			try {
				return await next();
			} catch (error) {
				attempts += 1;
				if (attempts > retries) {
					throw error;
				}
			}
		}
	})();
}

// ---------------------------------------------------------------------------
// Caller-side: contract-tagged transforms
// ---------------------------------------------------------------------------

const traceWithStringId = createTransform<
	ExampleStub,
	{ traceId: string }
>().caller(
	() =>
		async ({ next }) =>
			next()
)();

const auditWithBooleanFlag = createTransform<
	ExampleStub,
	{ audit: boolean }
>().caller(
	() =>
		async ({ next }) =>
			next()
)();

const traceWithNumericId = createTransform<
	ExampleStub,
	{ traceId: number }
>().caller(
	() =>
		async ({ next }) =>
			next()
)();

// ---------------------------------------------------------------------------
// Composition and conflict detection
// ---------------------------------------------------------------------------

const transformed = withTransforms(exampleNs)
	.get("x")
	.with(traceCallerInline)
	.with(retry(2))
	.with(traceWithStringId)
	.with(auditWithBooleanFlag);

void transformed.sum(1, 2);
void transformed.greet("Ada");

// @ts-expect-error wrong argument type for sum
void transformed.sum("1", 2);

// @ts-expect-error contract key `traceId` conflicts with existing type
void transformed.with(traceWithNumericId);

// ---------------------------------------------------------------------------
// Callee-side: inline handler via factory
// ---------------------------------------------------------------------------

const calleeLogging = createTransform<ExampleStub>().callee(
	() =>
		async ({ next }) => {
			return next();
		}
)();

void withCalleeTransforms(exampleStub, [calleeLogging]);

// ---------------------------------------------------------------------------
// Callee-side: parameterized (plain function returning a transform)
// ---------------------------------------------------------------------------

function calleeClamp(_max: number) {
	return createTransform<ExampleStub>().callee(() => async ({ next }) => {
		return next();
	})();
}

void withCalleeTransforms(exampleStub, [calleeClamp(100)]);

// ---------------------------------------------------------------------------
// Full transform: caller + callee via factory chain
// ---------------------------------------------------------------------------

const fullTransformFactory = createTransform<ExampleStub>()
	.caller(
		() =>
			async ({ next }) =>
				next()
	)
	.callee(
		() =>
			async ({ next }) =>
				next()
	);

// Unwrap: call outer factory, then inner callee factory, merge
const _callerCallee = fullTransformFactory();
const _calleeOnly = _callerCallee();
const fullTransform = {
	onCall: _callerCallee.onCall,
	onReceive: _calleeOnly.onReceive,
};

void withTransforms(exampleNs).get("x").with(fullTransform);
void withCalleeTransforms(exampleStub, [fullTransform]);

// ---------------------------------------------------------------------------
// Type-level assertion helper
// ---------------------------------------------------------------------------

type AssertEqual<T, U> = [T] extends [U]
	? [U] extends [T]
		? true
		: false
	: false;

type AssertTrue<T extends true> = T;

// ---------------------------------------------------------------------------
// createTransform<typeof codec>() — transform inference
// ---------------------------------------------------------------------------

// A "codec" transform with a typed output and contract
type MyOutput = { ok: true; value: number } | { ok: false; error: string };

const codecTransform = createTransform<
	ExampleStub,
	{ codec: true },
	Record<string, unknown>,
	MyOutput
>().caller(() => async ({ next }) => {
	return (await next()) as MyOutput;
})();

// Verify extraction types work on the codec
type _CheckStub = AssertTrue<
	AssertEqual<TransformStub<typeof codecTransform>, ExampleStub>
>;
type _CheckOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof codecTransform>, MyOutput>
>;
type _CheckContract = AssertTrue<
	AssertEqual<TransformContract<typeof codecTransform>, { codec: true }>
>;

// Build a transform from the codec — next() should return MyOutput
const metricsFromCodec = createTransform<typeof codecTransform>().caller(
	() =>
		async ({ next }) => {
			const value = await next();

			// value should be MyOutput, not unknown — this is the key assertion.
			// If value were `unknown`, assigning to MyOutput would fail.
			const typed: MyOutput = value;

			// Narrow to error case
			if (!typed.ok) {
				// typed.error is `string`
				const _err: string = typed.error;
			}

			return value;
		}
)();

// The derived transform should inherit stub, contract, context from codec
type _CheckDerivedStub = AssertTrue<
	AssertEqual<TransformStub<typeof metricsFromCodec>, ExampleStub>
>;
type _CheckDerivedContract = AssertTrue<
	AssertEqual<TransformContract<typeof metricsFromCodec>, { codec: true }>
>;
type _CheckDerivedOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof metricsFromCodec>, MyOutput>
>;

// ---------------------------------------------------------------------------
// Composition: .with(codec).with(metricsFromCodec) should compile
// ---------------------------------------------------------------------------

const composedStub = withTransforms(exampleNs)
	.get("x")
	.with(codecTransform)
	.with(metricsFromCodec);

void composedStub.sum(1, 2);
void composedStub.greet("Ada");

// ---------------------------------------------------------------------------
// Backward compatibility: plain stub type still works
// ---------------------------------------------------------------------------

const plainTransform = createTransform<ExampleStub>().caller(
	() =>
		async ({ next }) => {
			// next() returns unknown (default output)
			const value: unknown = await next();
			return value;
		}
)();

type _CheckPlainStub = AssertTrue<
	AssertEqual<TransformStub<typeof plainTransform>, ExampleStub>
>;
// Plain transform has no typed output — TransformOutput is unknown
type _CheckPlainOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof plainTransform>, unknown>
>;
// Plain transform has empty contract
type _CheckPlainContract = AssertTrue<
	AssertEqual<TransformContract<typeof plainTransform>, {}>
>;

// Can mix plain and codec-derived transforms
void withTransforms(exampleNs)
	.get("x")
	.with(plainTransform)
	.with(codecTransform)
	.with(metricsFromCodec);

// ---------------------------------------------------------------------------
// createTransform<typeof prev>() with custom context
// ---------------------------------------------------------------------------

type MyContext = { accountId: string; traceId: string };

const contextualCodec = createTransform<
	ExampleStub,
	{ contextualCodec: true },
	MyContext,
	MyOutput
>().caller(() => async ({ next, context }) => {
	// context should be MyContext
	const _acct: string = context.accountId;
	const _trace: string = context.traceId;
	return (await next()) as MyOutput;
})();

type _CheckCtxContext = AssertTrue<
	AssertEqual<TransformContextOf<typeof contextualCodec>, MyContext>
>;

const derivedFromContextual = createTransform<typeof contextualCodec>().caller(
	() =>
		async ({ next, context }) => {
			// Context should be inferred as MyContext
			const _acct: string = context.accountId;
			const _trace: string = context.traceId;

			// Output should be MyOutput
			const value: MyOutput = await next();
			return value;
		}
)();

type _CheckDerivedCtxContext = AssertTrue<
	AssertEqual<TransformContextOf<typeof derivedFromContextual>, MyContext>
>;
type _CheckDerivedCtxOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof derivedFromContextual>, MyOutput>
>;
type _CheckDerivedCtxContract = AssertTrue<
	AssertEqual<
		TransformContract<typeof derivedFromContextual>,
		{ contextualCodec: true }
	>
>;

// ---------------------------------------------------------------------------
// Contract conflict detection still works with derived transforms
// ---------------------------------------------------------------------------

// A transform whose contract conflicts with codecTransform's { codec: true }
const conflictingCodec = createTransform<
	ExampleStub,
	{ codec: number }
>().caller(
	() =>
		async ({ next }) =>
			next()
)();

void withTransforms(exampleNs)
	.get("x")
	.with(codecTransform)
	// @ts-expect-error contract key `codec` conflicts (true vs number)
	.with(conflictingCodec);

// But compatible contracts compose fine
const compatibleCodec = createTransform<ExampleStub, { codec: true }>().caller(
	() =>
		async ({ next }) =>
			next()
)();

void withTransforms(exampleNs)
	.get("x")
	.with(codecTransform)
	.with(compatibleCodec);

// ---------------------------------------------------------------------------
// createTransform<typeof fullTransform>() — inference from caller+callee
// ---------------------------------------------------------------------------

const fullWithOutput = createTransform<
	ExampleStub,
	{ full: true },
	Record<string, unknown>,
	MyOutput
>()
	.caller(() => async ({ next }) => {
		return (await next()) as MyOutput;
	})
	.callee(() => async ({ next }) => {
		return next();
	});

// Unwrap: the caller factory result has `onCall` with full phantom types.
// Note: destructuring into a plain object literal loses phantom symbol
// properties, so we use `fullCallerCallee` directly for type inference.
const fullCallerCallee = fullWithOutput();
const fullCalleeOnly = fullCallerCallee();

// Build a transform from the caller+callee factory result (retains phantoms)
const derivedFromFull = createTransform<typeof fullCallerCallee>().caller(
	() =>
		async ({ next }) => {
			const value: MyOutput = await next();
			return value;
		}
)();

type _CheckFullDerivedStub = AssertTrue<
	AssertEqual<TransformStub<typeof derivedFromFull>, ExampleStub>
>;
type _CheckFullDerivedOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof derivedFromFull>, MyOutput>
>;
type _CheckFullDerivedContract = AssertTrue<
	AssertEqual<TransformContract<typeof derivedFromFull>, { full: true }>
>;

// Compose: full + derived (use the reconstructed object for runtime)
const fullCombined = {
	onCall: fullCallerCallee.onCall,
	onReceive: fullCalleeOnly.onReceive,
};
void withTransforms(exampleNs)
	.get("x")
	.with(fullCombined)
	.with(derivedFromFull);

// ---------------------------------------------------------------------------
// TAddError — per-method return type widening
// ---------------------------------------------------------------------------

// Structural Result types (no better-result dependency)
type Ok<T, E = never> = {
	status: "ok";
	value: T;
	isOk(): boolean;
	isErr(): boolean;
};
type Err<T, E> = {
	status: "error";
	error: E;
	isOk(): boolean;
	isErr(): boolean;
};
type Result<T, E> = Ok<T, E> | Err<T, E>;

// Domain errors
class BusyError {
	readonly _tag = "BusyError" as const;
	constructor(readonly message: string) {}
}

class RateLimitError {
	readonly _tag = "RateLimitError" as const;
	constructor(readonly message: string) {}
}

// A DO-like stub with mixed return types: some Result, some plain
type ResultDO = {
	id: string;
	increment(by: number): Promise<Result<number, never>>;
	slowIncrement(by: number, delayMs: number): Promise<Result<number, never>>;
	getCount(): Promise<Result<number, never>>;
	getName(): Promise<string>; // not a Result — should NOT be widened
};

const resultStub: ResultDO = {
	id: "r-1",
	async increment(_by) {
		return {
			status: "ok",
			value: 1,
			isOk: () => true,
			isErr: () => false,
		} as Result<number, never>;
	},
	async slowIncrement(_by, _delay) {
		return {
			status: "ok",
			value: 1,
			isOk: () => true,
			isErr: () => false,
		} as Result<number, never>;
	},
	async getCount() {
		return {
			status: "ok",
			value: 0,
			isOk: () => true,
			isErr: () => false,
		} as Result<number, never>;
	},
	async getName() {
		return "test";
	},
};

const resultNs = {
	newUniqueId: () => ({ toString: () => "mock-id", name: "mock" }),
	idFromName: (name: string) => ({ toString: () => name, name }),
	idFromString: (id: string) => ({ toString: () => id, name: id }),
	get: (_id: unknown): ResultDO => resultStub,
};

// ---------------------------------------------------------------------------
// OutputFn — per-method return type transformation via type-level functions
// ---------------------------------------------------------------------------

// An OutputFn that widens the error channel of Result-returning methods
interface AddBusyError extends OutputFn {
	readonly Out: this["In"] extends Result<infer T, infer E>
		? Result<T, E | BusyError>
		: this["In"];
}

const busyTransform = createTransform<
	ResultDO,
	{},
	Record<string, unknown>,
	AddBusyError
>().caller(
	() =>
		async ({ next }) =>
			next()
)();

// Verify TransformOutput extracts AddBusyError
type _CheckOutputFn = AssertTrue<
	AssertEqual<TransformOutput<typeof busyTransform>, AddBusyError>
>;

// ---------------------------------------------------------------------------
// .with(busyTransform) widens Result error channels per-method via OutputFn
// ---------------------------------------------------------------------------

const widenedStub = withTransforms(resultNs).get("x").with(busyTransform);

// increment: Promise<Result<number, never>> → Promise<Result<number, BusyError>>
async function testWidenedIncrement() {
	const result = await widenedStub.increment(1);

	if (result.status === "error") {
		// error should now include BusyError
		const _err: BusyError = result.error;
	}
	if (result.status === "ok") {
		const _val: number = result.value;
	}
}

// getName: Promise<string> — NOT widened (not a Result, AddBusyError returns as-is)
async function testNonResultUnchanged() {
	const name = await widenedStub.getName();
	const _s: string = name;
}

// A no-output transform preserves original signatures
const noOutputTransform = createTransform<ResultDO>().caller(
	() =>
		async ({ next }) =>
			next()
)();

const notWidened = withTransforms(resultNs).get("x").with(noOutputTransform);

async function testNotWidened() {
	const result = await notWidened.increment(1);

	if (result.status === "ok") {
		const _val: number = result.value;
	}
	// With never error, error branch should narrow properly
	if (result.status === "error") {
		const _err: never = result.error;
	}
}

// Void the test functions so they're used
void testWidenedIncrement;
void testNonResultUnchanged;
void testNotWidened;

// ---------------------------------------------------------------------------
// createTransform<typeof busyTransform>() inherits OutputFn
// ---------------------------------------------------------------------------

const derivedFromBusy = createTransform<typeof busyTransform>().caller(
	() =>
		async ({ next }) =>
			next()
)();

type _CheckDerivedBusyOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof derivedFromBusy>, AddBusyError>
>;

// ---------------------------------------------------------------------------
// Inline .with() handler — passthrough preserves TPrevOutput
// ---------------------------------------------------------------------------

// No prior output → passthrough → TPrevOutput stays unknown → original sigs
const inlinePassthrough = withTransforms(exampleNs)
	.get("x")
	.with(async ({ next }) => next());

// sum should still be callable with original sig
void inlinePassthrough.sum(1, 2);
void inlinePassthrough.greet("Ada");

// @ts-expect-error wrong argument type
void inlinePassthrough.sum("1", 2);

// ---------------------------------------------------------------------------
// Inline .with() handler — next({ result: X }) overrides to X
// ---------------------------------------------------------------------------

const inlineOverride = withTransforms(exampleNs)
	.get("x")
	.with(async ({ next }) => next({ result: "hello" }));

// All methods now return Promise<string>
async function testInlineOverride() {
	const s = await inlineOverride.sum(1, 2);
	const _str: string = s;

	const g = await inlineOverride.greet("Ada");
	const _str2: string = g;
}
void testInlineOverride;

// ---------------------------------------------------------------------------
// Inline .with() handler — explicit return (no next) → blanket override
// ---------------------------------------------------------------------------

const inlineExplicit = withTransforms(exampleNs)
	.get("x")
	.with(async (_ctx) => 42 as number);

async function testInlineExplicit() {
	const n = await inlineExplicit.sum(1, 2);
	const _num: number = n;
}
void testInlineExplicit;

// ---------------------------------------------------------------------------
// Inline .with() handler — mixed branches (next | explicit) → union
// ---------------------------------------------------------------------------

const inlineMixed = withTransforms(exampleNs)
	.get("x")
	.with(async ({ next }) => {
		if (Math.random() > 0.5) {
			return "fallback";
		}
		return next();
	});

// Return type should be string | number | string (collapsed: string | number)
// Since TPrevOutput is unknown, next() returns the method return union,
// but the inline handler wraps it in TransformResult which unwraps.
// Actually: next() returns TransformResult<MethodReturnUnion> and
// "fallback" returns string. Union: string | TransformResult<number | string>
// → UnwrapTransformResult → string | number | string → string | number
async function testInlineMixed() {
	const result = await inlineMixed.sum(1, 2);
	// result is string | number (both branches possible)
	if (typeof result === "string") {
		const _s: string = result;
	}
	if (typeof result === "number") {
		const _n: number = result;
	}
}
void testInlineMixed;

// ---------------------------------------------------------------------------
// Chained inline handlers — accumulation
// ---------------------------------------------------------------------------

class ErrorObject {
	readonly tag = "error" as const;
	constructor(readonly message: string) {}
}

const chainedInline = withTransforms(exampleNs)
	.get("x")
	// First: passthrough
	.with(async ({ next }) => next())
	// Second: may return ErrorObject or pass through
	.with(async ({ next }) => {
		if (Math.random() > 0.5) {
			return new ErrorObject("busy");
		}
		return next();
	})
	// Third: override to string
	.with(async ({ next }) => next({ result: "override" }));

// After third .with(): TPrevOutput = string (next({result}) always returns string)
async function testChainedOverride() {
	const result = await chainedInline.sum(1, 2);
	const _s: string = result;
}
void testChainedOverride;

// Without the third override — the second handler produces string | number | ErrorObject
const chainedNoOverride = withTransforms(exampleNs)
	.get("x")
	.with(async ({ next }) => next())
	.with(async ({ next }) => {
		if (Math.random() > 0.5) {
			return new ErrorObject("busy");
		}
		return next();
	});

async function testChainedNoOverride() {
	const result = await chainedNoOverride.sum(1, 2);
	// Should be ErrorObject | number | string (the method return union + ErrorObject)
	if (result instanceof ErrorObject) {
		const _e: ErrorObject = result;
	}
}
void testChainedNoOverride;

// ---------------------------------------------------------------------------
// Named transform with OutputFn + inline handler after
// ---------------------------------------------------------------------------

const busyThenOverride = withTransforms(resultNs)
	.get("x")
	.with(busyTransform)
	.with(async ({ next }) => next({ result: "overridden" }));

async function testBusyThenOverride() {
	const result = await busyThenOverride.increment(1);
	const _s: string = result;
}
void testBusyThenOverride;

// ---------------------------------------------------------------------------
// Named transform (passthrough) preserves TPrevOutput from prior step
// ---------------------------------------------------------------------------

// noOutputTransform has TOutput = unknown → ComputeOutput preserves TPrev
const namedPassthrough = withTransforms(resultNs)
	.get("x")
	.with(busyTransform)
	.with(noOutputTransform);

// busyTransform's AddBusyError should still apply
async function testNamedPassthrough() {
	const result = await namedPassthrough.increment(1);
	if (result.status === "error") {
		const _err: BusyError = result.error;
	}
}
void testNamedPassthrough;

// ---------------------------------------------------------------------------
// .transforms() on createTransform — predecessor awareness
// ---------------------------------------------------------------------------

const codecForTests = createTransform<
	ExampleStub,
	{},
	Record<string, unknown>,
	MyOutput
>().caller(() => async ({ next }) => {
	return (await next()) as MyOutput;
})();

const afterCodec = createTransform<ExampleStub>()
	.transforms([codecForTests])
	.caller(() => async ({ next }) => {
		// next() should return MyOutput (from codecForTests)
		const value = await next();
		const _typed: MyOutput = value;
		return value;
	})();

type _CheckAfterCodecOutput = AssertTrue<
	AssertEqual<TransformOutput<typeof afterCodec>, MyOutput>
>;

// ---------------------------------------------------------------------------
// .transforms() with multiple — last declared output wins (right to left)
// ---------------------------------------------------------------------------

const plainForChain = createTransform<ExampleStub>().caller(
	() =>
		async ({ next }) =>
			next()
)();

const afterMultiple = createTransform<ExampleStub>()
	.transforms([plainForChain, codecForTests])
	.caller(() => async ({ next }) => {
		// next() should see MyOutput (codecForTests is closer to wire, has output)
		const value = await next();
		const _typed: MyOutput = value;
		return value;
	})();
