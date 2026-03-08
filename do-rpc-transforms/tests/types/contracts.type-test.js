import { createTransform, withCalleeTransforms, withTransforms, } from "../../src";
const exampleStub = {
    id: "id-1",
    async sum(a, b) {
        return a + b;
    },
    async greet(name) {
        return `hello ${name}`;
    },
};
const exampleNs = {
    newUniqueId: () => ({ toString: () => "mock-id", name: "mock" }),
    idFromName: (name) => ({ toString: () => name, name }),
    idFromString: (id) => ({ toString: () => id, name: id }),
    get: (_id) => exampleStub,
};
// ---------------------------------------------------------------------------
// Caller-side: inline handler via factory
// ---------------------------------------------------------------------------
const traceCallerInline = createTransform().caller(() => async ({ next }) => {
    return next();
})();
// ---------------------------------------------------------------------------
// Caller-side: parameterized (plain function returning a transform)
// ---------------------------------------------------------------------------
function retry(retries) {
    return createTransform().caller(() => async ({ next }) => {
        let attempts = 0;
        while (true) {
            try {
                return await next();
            }
            catch (error) {
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
const traceWithStringId = createTransform().caller(() => async ({ next }) => next())();
const auditWithBooleanFlag = createTransform().caller(() => async ({ next }) => next())();
const traceWithNumericId = createTransform().caller(() => async ({ next }) => next())();
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
const calleeLogging = createTransform().callee(() => async ({ next }) => {
    return next();
})();
void withCalleeTransforms(exampleStub, [calleeLogging]);
// ---------------------------------------------------------------------------
// Callee-side: parameterized (plain function returning a transform)
// ---------------------------------------------------------------------------
function calleeClamp(_max) {
    return createTransform().callee(() => async ({ next }) => {
        return next();
    })();
}
void withCalleeTransforms(exampleStub, [calleeClamp(100)]);
// ---------------------------------------------------------------------------
// Full transform: caller + callee via factory chain
// ---------------------------------------------------------------------------
const fullTransformFactory = createTransform()
    .caller(() => async ({ next }) => next())
    .callee(() => async ({ next }) => next());
// Unwrap: call outer factory, then inner callee factory, merge
const _callerCallee = fullTransformFactory();
const _calleeOnly = _callerCallee();
const fullTransform = {
    onCall: _callerCallee.onCall,
    onReceive: _calleeOnly.onReceive,
};
void withTransforms(exampleNs).get("x").with(fullTransform);
void withCalleeTransforms(exampleStub, [fullTransform]);
const codecTransform = createTransform().caller(() => async ({ next }) => {
    return (await next());
})();
// Build a transform from the codec — next() should return MyOutput
const metricsFromCodec = createTransform().caller(() => async ({ next }) => {
    const value = await next();
    // value should be MyOutput, not unknown — this is the key assertion.
    // If value were `unknown`, assigning to MyOutput would fail.
    const typed = value;
    // Narrow to error case
    if (!typed.ok) {
        // typed.error is `string`
        const _err = typed.error;
    }
    return value;
})();
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
const plainTransform = createTransform().caller(() => async ({ next }) => {
    // next() returns unknown (default output)
    const value = await next();
    return value;
})();
// Can mix plain and codec-derived transforms
void withTransforms(exampleNs)
    .get("x")
    .with(plainTransform)
    .with(codecTransform)
    .with(metricsFromCodec);
const contextualCodec = createTransform().caller(() => async ({ next, context }) => {
    // context should be MyContext
    const _acct = context.accountId;
    const _trace = context.traceId;
    return (await next());
})();
const derivedFromContextual = createTransform().caller(() => async ({ next, context }) => {
    // Context should be inferred as MyContext
    const _acct = context.accountId;
    const _trace = context.traceId;
    // Output should be MyOutput
    const value = await next();
    return value;
})();
// ---------------------------------------------------------------------------
// Contract conflict detection still works with derived transforms
// ---------------------------------------------------------------------------
// A transform whose contract conflicts with codecTransform's { codec: true }
const conflictingCodec = createTransform().caller(() => async ({ next }) => next())();
void withTransforms(exampleNs)
    .get("x")
    .with(codecTransform)
    // @ts-expect-error contract key `codec` conflicts (true vs number)
    .with(conflictingCodec);
// But compatible contracts compose fine
const compatibleCodec = createTransform().caller(() => async ({ next }) => next())();
void withTransforms(exampleNs)
    .get("x")
    .with(codecTransform)
    .with(compatibleCodec);
// ---------------------------------------------------------------------------
// createTransform<typeof fullTransform>() — inference from caller+callee
// ---------------------------------------------------------------------------
const fullWithOutput = createTransform()
    .caller(() => async ({ next }) => {
    return (await next());
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
const derivedFromFull = createTransform().caller(() => async ({ next }) => {
    const value = await next();
    return value;
})();
// Compose: full + derived (use the reconstructed object for runtime)
const fullCombined = {
    onCall: fullCallerCallee.onCall,
    onReceive: fullCalleeOnly.onReceive,
};
void withTransforms(exampleNs)
    .get("x")
    .with(fullCombined)
    .with(derivedFromFull);
// Domain errors
class BusyError {
    message;
    _tag = "BusyError";
    constructor(message) {
        this.message = message;
    }
}
class RateLimitError {
    message;
    _tag = "RateLimitError";
    constructor(message) {
        this.message = message;
    }
}
const resultStub = {
    id: "r-1",
    async increment(_by) {
        return {
            status: "ok",
            value: 1,
            isOk: () => true,
            isErr: () => false,
        };
    },
    async slowIncrement(_by, _delay) {
        return {
            status: "ok",
            value: 1,
            isOk: () => true,
            isErr: () => false,
        };
    },
    async getCount() {
        return {
            status: "ok",
            value: 0,
            isOk: () => true,
            isErr: () => false,
        };
    },
    async getName() {
        return "test";
    },
};
const resultNs = {
    newUniqueId: () => ({ toString: () => "mock-id", name: "mock" }),
    idFromName: (name) => ({ toString: () => name, name }),
    idFromString: (id) => ({ toString: () => id, name: id }),
    get: (_id) => resultStub,
};
const busyTransform = createTransform().caller(() => async ({ next }) => next())();
// ---------------------------------------------------------------------------
// .with(busyTransform) widens Result error channels per-method via OutputFn
// ---------------------------------------------------------------------------
const widenedStub = withTransforms(resultNs).get("x").with(busyTransform);
// increment: Promise<Result<number, never>> → Promise<Result<number, BusyError>>
async function testWidenedIncrement() {
    const result = await widenedStub.increment(1);
    if (result.status === "error") {
        // error should now include BusyError
        const _err = result.error;
    }
    if (result.status === "ok") {
        const _val = result.value;
    }
}
// getName: Promise<string> — NOT widened (not a Result, AddBusyError returns as-is)
async function testNonResultUnchanged() {
    const name = await widenedStub.getName();
    const _s = name;
}
// A no-output transform preserves original signatures
const noOutputTransform = createTransform().caller(() => async ({ next }) => next())();
const notWidened = withTransforms(resultNs).get("x").with(noOutputTransform);
async function testNotWidened() {
    const result = await notWidened.increment(1);
    if (result.status === "ok") {
        const _val = result.value;
    }
    // With never error, error branch should narrow properly
    if (result.status === "error") {
        const _err = result.error;
    }
}
// Void the test functions so they're used
void testWidenedIncrement;
void testNonResultUnchanged;
void testNotWidened;
// ---------------------------------------------------------------------------
// createTransform<typeof busyTransform>() inherits OutputFn
// ---------------------------------------------------------------------------
const derivedFromBusy = createTransform().caller(() => async ({ next }) => next())();
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
    const _str = s;
    const g = await inlineOverride.greet("Ada");
    const _str2 = g;
}
void testInlineOverride;
// ---------------------------------------------------------------------------
// Inline .with() handler — explicit return (no next) → blanket override
// ---------------------------------------------------------------------------
const inlineExplicit = withTransforms(exampleNs)
    .get("x")
    .with(async (_ctx) => 42);
async function testInlineExplicit() {
    const n = await inlineExplicit.sum(1, 2);
    const _num = n;
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
        const _s = result;
    }
    if (typeof result === "number") {
        const _n = result;
    }
}
void testInlineMixed;
// ---------------------------------------------------------------------------
// Chained inline handlers — accumulation
// ---------------------------------------------------------------------------
class ErrorObject {
    message;
    tag = "error";
    constructor(message) {
        this.message = message;
    }
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
    const _s = result;
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
        const _e = result;
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
    const _s = result;
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
        const _err = result.error;
    }
}
void testNamedPassthrough;
// ---------------------------------------------------------------------------
// .transforms() on createTransform — predecessor awareness
// ---------------------------------------------------------------------------
const codecForTests = createTransform().caller(() => async ({ next }) => {
    return (await next());
})();
const afterCodec = createTransform()
    .transforms([codecForTests])
    .caller(() => async ({ next }) => {
    // next() should return MyOutput (from codecForTests)
    const value = await next();
    const _typed = value;
    return value;
})();
// ---------------------------------------------------------------------------
// .transforms() with multiple — last declared output wins (right to left)
// ---------------------------------------------------------------------------
const plainForChain = createTransform().caller(() => async ({ next }) => next())();
const afterMultiple = createTransform()
    .transforms([plainForChain, codecForTests])
    .caller(() => async ({ next }) => {
    // next() should see MyOutput (codecForTests is closer to wire, has output)
    const value = await next();
    const _typed = value;
    return value;
})();
