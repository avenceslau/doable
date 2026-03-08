export const TRANSFORM_CALL_ID_CONTEXT_KEY = "__doRpcTransformsCallId";
function createTransformCallId() {
    if (typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `call-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
function ensureTransformCallId(context) {
    if (typeof context[TRANSFORM_CALL_ID_CONTEXT_KEY] === "string") {
        return context;
    }
    return {
        ...context,
        [TRANSFORM_CALL_ID_CONTEXT_KEY]: createTransformCallId(),
    };
}
function mergeContextPreservingCallId(base, patch) {
    const merged = {
        ...base,
        ...patch,
    };
    const baseCallId = base[TRANSFORM_CALL_ID_CONTEXT_KEY];
    if (typeof baseCallId === "string") {
        merged[TRANSFORM_CALL_ID_CONTEXT_KEY] = baseCallId;
    }
    return ensureTransformCallId(merged);
}
// ---------------------------------------------------------------------------
// Internal wire envelope
// ---------------------------------------------------------------------------
const ENVELOPE_BRAND = "__doRpcTransforms";
function encodeEnvelope(args, context) {
    return [{ [ENVELOPE_BRAND]: 1, args, context }];
}
function decodeEnvelope(rawArgs) {
    if (rawArgs.length === 1 &&
        typeof rawArgs[0] === "object" &&
        rawArgs[0] !== null &&
        ENVELOPE_BRAND in rawArgs[0] &&
        rawArgs[0][ENVELOPE_BRAND] === 1) {
        const envelope = rawArgs[0];
        return {
            args: envelope.args,
            context: envelope.context,
        };
    }
    return undefined;
}
// Implementation
export function createTransform() {
    // The runtime implementation is type-erased — all the interesting
    // type work happens in the function signature and TransformBuilder.
    // We use `any` internally to avoid fighting conditional types that
    // TypeScript can't resolve inside the body.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = {
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
        caller(callerFactory) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = (...args) => {
                return { onCall: callerFactory(...args) };
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result.callee = (calleeFactory) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (...callerArgs) => {
                    const callerHandler = callerFactory(...callerArgs);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const combined = (...calleeArgs) => {
                        return { onReceive: calleeFactory(...calleeArgs) };
                    };
                    combined.onCall =
                        callerHandler;
                    return combined;
                };
            };
            return result;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callee(calleeFactory) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = (...args) => {
                return { onReceive: calleeFactory(...args) };
            };
            // Use Object.defineProperty because strict mode functions have a
            // non-configurable `.caller` accessor that throws on direct assignment.
            Object.defineProperty(result, "caller", {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value: (callerFactory) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (...callerArgs) => {
                        const callerHandler = callerFactory(...callerArgs);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const combined = (...calleeArgs) => {
                            return { onReceive: calleeFactory(...calleeArgs) };
                        };
                        combined.onCall =
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
function createSplitTransformBuilder() {
    let callerFactory;
    let calleeFactory;
    const invokeFactory = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args) => {
        if (!factory) {
            throw new Error("[do-rpc-transforms] Missing transform factory");
        }
        return args.length === 0 ? factory(undefined) : factory(args[0]);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = {
        callerParams() {
            return builder;
        },
        calleeParams() {
            return builder;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        caller(factory) {
            callerFactory = factory;
            if (factory.length === 0) {
                builder.onCall = invokeFactory(callerFactory, []);
            }
            return builder;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callee(factory) {
            calleeFactory = factory;
            if (factory.length === 0) {
                builder.onReceive = invokeFactory(calleeFactory, []);
            }
            return builder;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callerConfig(...args) {
            return {
                onCall: invokeFactory(callerFactory, args),
            };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        calleeConfig(...args) {
            return {
                onReceive: invokeFactory(calleeFactory, args),
            };
        },
    };
    return builder;
}
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
export function withTransforms(namespace) {
    return createWrappedNamespace(namespace, []);
}
/**
 * Creates a proxy around a DurableObjectNamespace that wraps stubs
 * returned by `.get()`, `.getByName()`, and `.getExisting()` with
 * the transform pipeline.
 */
function createWrappedNamespace(namespace, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
transforms
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) {
    const stubMethods = new Set(["get", "getByName", "getExisting"]);
    return new Proxy(namespace, {
        get(target, property, _receiver) {
            if (property === "jurisdiction") {
                return (...args) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const inner = target[property](...args);
                    return createWrappedNamespace(inner, transforms);
                };
            }
            if (typeof property === "string" && stubMethods.has(property)) {
                return (...args) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const rawStub = target[property](...args);
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
function createWrappedStub(stub, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
transforms) {
    const proxy = new Proxy(stub, {
        get(target, property, _receiver) {
            if (property === "with") {
                return (transformOrHandler) => {
                    // Check for `onCall` first: a combined caller+callee transform
                    // from `.caller().callee()` is a callable function with `onCall`
                    // attached.  We must not treat it as a bare handler.
                    const transform = typeof transformOrHandler === "function" &&
                        !("onCall" in transformOrHandler)
                        ? { onCall: transformOrHandler }
                        : transformOrHandler;
                    return createWrappedStub(stub, [...transforms, transform]);
                };
            }
            if (property === "unwrap") {
                return () => stub;
            }
            const value = Reflect.get(target, property);
            if (typeof property !== "string" || typeof value !== "function") {
                return value;
            }
            return (...initialArgs) => {
                const methodName = property;
                const id = readStubId(stub);
                const callContext = ensureTransformCallId({});
                const run = (index, args, ctx, shortCircuit) => {
                    const transform = transforms[index];
                    if (transform === undefined) {
                        // End of caller pipeline — if a previous transform
                        // provided a result via next({ result }), use it
                        // instead of making the RPC call.
                        if (shortCircuit !== undefined) {
                            return Promise.resolve(shortCircuit);
                        }
                        const shouldSendContext = Object.keys(ctx).some((key) => key !== TRANSFORM_CALL_ID_CONTEXT_KEY);
                        // Call the method directly.
                        // If the context carries user metadata, wrap in an
                        // envelope so the callee side can extract it.
                        if (shouldSendContext) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            return target[property](...encodeEnvelope(args, ctx));
                        }
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        return target[property](...args);
                    }
                    return Promise.resolve(transform.onCall({
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
                        next: ((input) => {
                            const nextArgs = input?.args ?? args;
                            const nextCtx = input?.context
                                ? mergeContextPreservingCallId(ctx, input.context)
                                : ctx;
                            const nextResult = input?.result !== undefined ? input.result : shortCircuit;
                            return run(index + 1, nextArgs, nextCtx, nextResult);
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        }),
                    }));
                };
                return run(0, initialArgs, callContext);
            };
        },
    });
    return proxy;
}
function readStubId(stub) {
    if (stub == null || !("id" in stub)) {
        return undefined;
    }
    return stub.id;
}
/**
 * Creates a dispatch function that runs the callee transform pipeline
 * and then delegates to the original method.
 *
 * `originalMethods` maps method names to their **original** implementations
 * (captured before any patching).  The dispatch function calls the original
 * so that patched wrappers on the prototype don't cause infinite loops.
 */
function buildCalleeDispatch(resolveTransforms, originalMethods, options) {
    async function applyContextPipeline(self, method, args, transforms, initialContext, state, env) {
        let nextContext = ensureTransformCallId({
            ...initialContext,
        });
        const pipeline = [
            self,
            ...transforms,
        ];
        for (const contributor of pipeline) {
            const addContext = contributor.addTransformContext;
            if (typeof addContext !== "function") {
                continue;
            }
            const callableAddContext = contributor === self
                ? getDecoratedOriginalMethod(self.constructor, "addTransformContext") ?? addContext
                : addContext;
            const added = await callableAddContext.call(contributor, nextContext, {
                instance: self,
                method,
                args,
                state,
                env,
            });
            if (added && typeof added === "object") {
                nextContext = mergeContextPreservingCallId(nextContext, added);
            }
        }
        return nextContext;
    }
    return function dispatchHandler(methodName, rawArgs, context) {
        const self = this;
        const key = methodName;
        const originalMethod = originalMethods.get(methodName);
        const transforms = resolveTransforms(self, methodName);
        if (!originalMethod) {
            throw new Error(`[do-rpc-transforms] Unknown method: ${methodName}`);
        }
        const state = options?.state ?? self.ctx;
        const env = options?.env ?? self.env;
        const id = readStubId(self) ?? readStubId(state);
        const run = (index, args, ctx, shortCircuit) => {
            const transform = transforms[index];
            if (transform === undefined) {
                // End of pipeline — if a previous transform provided a
                // result via next({ result }), use it instead of calling
                // the actual method.
                if (shortCircuit !== undefined) {
                    return Promise.resolve(shortCircuit);
                }
                return originalMethod.apply(self, args);
            }
            return Promise.resolve(transform.onReceive({
                instance: self,
                method: key,
                id,
                args,
                context: ctx,
                state,
                env,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                next: ((input) => {
                    const nextArgs = input?.args ?? args;
                    const nextCtx = input?.context
                        ? mergeContextPreservingCallId(ctx, input.context)
                        : ctx;
                    const nextResult = input?.result !== undefined ? input.result : shortCircuit;
                    return run(index + 1, nextArgs, nextCtx, nextResult);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }),
            }));
        };
        const rawMethodArgs = rawArgs;
        const callContext = ensureTransformCallId(context ?? {});
        return applyContextPipeline(self, key, rawArgs, transforms, callContext, state, env).then((enrichedContext) => run(0, rawMethodArgs, enrichedContext));
    };
}
/**
 * Collects original method references from an instance and its prototype
 * chain, before any patching occurs.
 */
function collectOriginalMethods(instance) {
    const methods = new Map();
    const seen = new Set();
    // Own methods (plain objects)
    for (const key of Object.getOwnPropertyNames(instance)) {
        if (key === "constructor") {
            continue;
        }
        const value = instance[key];
        if (typeof value === "function") {
            methods.set(key, value);
            seen.add(key);
        }
    }
    // Prototype methods (class instances)
    let proto = Object.getPrototypeOf(instance);
    while (proto !== null && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (key === "constructor" || seen.has(key)) {
                continue;
            }
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (descriptor && typeof descriptor.value === "function") {
                methods.set(key, descriptor.value);
                seen.add(key);
            }
        }
        proto = Object.getPrototypeOf(proto);
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
export function withCalleeTransforms(instance, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
transforms, options) {
    if (transforms.length === 0) {
        return instance;
    }
    const originalMethods = collectOriginalMethods(instance);
    const dispatch = buildCalleeDispatch((_instance, _methodName) => transforms, originalMethods, options);
    // Patch own methods on the instance (plain objects in tests)
    originalMethods.forEach((_fn, key) => {
        if (Object.prototype.hasOwnProperty.call(instance, key)) {
            instance[key] = function (...rawArgs) {
                const envelope = decodeEnvelope(rawArgs);
                const args = envelope ? envelope.args : rawArgs;
                const ctx = envelope?.context ?? {};
                return dispatch.call(this, key, args, ctx);
            };
        }
    });
    // Patch prototype methods via a shadow prototype so that workerd's
    // JSRPC dispatch (which reads from the prototype) goes through the
    // transform pipeline.
    const originalProto = Object.getPrototypeOf(instance);
    if (originalProto !== null && originalProto !== Object.prototype) {
        const shadow = Object.create(originalProto);
        let needsShadow = false;
        originalMethods.forEach((_fn, key) => {
            // Skip own methods (already patched above)
            if (Object.prototype.hasOwnProperty.call(instance, key)) {
                return;
            }
            shadow[key] = function (...rawArgs) {
                const envelope = decodeEnvelope(rawArgs);
                const args = envelope ? envelope.args : rawArgs;
                const ctx = envelope?.context ?? {};
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
const decoratedOriginalMethodsSymbol = Symbol.for("__doRpcTransforms_decoratorsOriginalMethods");
function readClassTransformRegistry(klass) {
    if (!Object.prototype.hasOwnProperty.call(klass, classTransformsSymbol)) {
        return undefined;
    }
    const rec = klass;
    const value = rec[classTransformsSymbol];
    return Array.isArray(value) ? value : undefined;
}
function getOrCreateClassTransformRegistry(klass) {
    const existing = readClassTransformRegistry(klass);
    if (existing) {
        return existing;
    }
    const list = [];
    Object.defineProperty(klass, classTransformsSymbol, {
        value: list,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return list;
}
function registerClassTransforms(klass, transforms) {
    const registry = getOrCreateClassTransformRegistry(klass);
    for (const transform of transforms) {
        if (!registry.includes(transform)) {
            registry.push(transform);
        }
    }
}
function readMethodTransformRegistry(prototype) {
    if (!Object.prototype.hasOwnProperty.call(prototype, methodTransformsSymbol)) {
        return undefined;
    }
    const rec = prototype;
    const value = rec[methodTransformsSymbol];
    return value instanceof Map ? value : undefined;
}
function getOrCreateMethodTransformRegistry(prototype) {
    const existing = readMethodTransformRegistry(prototype);
    if (existing) {
        return existing;
    }
    const map = new Map();
    Object.defineProperty(prototype, methodTransformsSymbol, {
        value: map,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return map;
}
function registerMethodTransforms(target, propertyKey, transforms) {
    if (typeof propertyKey !== "string") {
        throw new Error("[do-rpc-transforms] useDOTransforms only supports string method names");
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
export function useDOTransforms(klass) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = {
        with(...transforms) {
            registerClassTransforms(klass, transforms);
            patchDecoratedClass(klass);
            return builder;
        },
        method(methodName) {
            return {
                with(...transforms) {
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
    return builder;
}
function collectDecoratedMethodTransforms(instance) {
    const collected = new Map();
    const prototypes = [];
    let proto = Object.getPrototypeOf(instance);
    while (proto !== null && proto !== Object.prototype) {
        prototypes.unshift(proto);
        proto = Object.getPrototypeOf(proto);
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
function collectClassDecoratedTransforms(klass
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = [];
    let current = klass;
    while (current !== null && current !== Function.prototype) {
        const decorated = readClassTransformRegistry(current);
        if (decorated && decorated.length > 0) {
            chain.unshift(decorated);
        }
        current = Object.getPrototypeOf(current);
    }
    return chain.flat();
}
function getOrCreateDecoratedOriginalMethods(klass) {
    const classProto = klass.prototype;
    const existing = classProto[decoratedOriginalMethodsSymbol];
    if (existing instanceof Map) {
        return existing;
    }
    const originalMethods = new Map();
    Object.defineProperty(classProto, decoratedOriginalMethodsSymbol, {
        value: originalMethods,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return originalMethods;
}
function getDecoratedOriginalMethod(klass, methodName) {
    const classProto = klass.prototype;
    const existing = classProto[decoratedOriginalMethodsSymbol];
    if (!(existing instanceof Map)) {
        return undefined;
    }
    return existing.get(methodName);
}
function patchDecoratedClass(klass) {
    const classProto = klass.prototype;
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
            originalMethods.set(key, descriptor.value);
        }
    }
    const dispatch = buildCalleeDispatch((instance, methodName) => {
        const classTransforms = collectClassDecoratedTransforms(instance.constructor);
        const methodTransforms = collectDecoratedMethodTransforms(instance);
        return [
            ...classTransforms,
            ...(methodTransforms.get(methodName) ?? []),
        ];
    }, originalMethods);
    originalMethods.forEach((_fn, key) => {
        classProto[key] = function (...rawArgs) {
            const envelope = decodeEnvelope(rawArgs);
            const args = envelope ? envelope.args : rawArgs;
            const ctx = envelope?.context ?? {};
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
