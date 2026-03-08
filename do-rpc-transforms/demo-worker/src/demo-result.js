export class TaggedError extends Error {
    _tag;
    constructor(tag, message) {
        super(message);
        this.name = tag;
        this._tag = tag;
    }
}
const RESULT_WIRE_BRAND = "__demoResultWire";
export const Result = {
    ok(value) {
        return { status: "ok", value };
    },
    err(error) {
        return { status: "error", error };
    },
    isError(value) {
        return value.status === "error";
    },
    serialize(value) {
        if (value.status === "ok") {
            return {
                [RESULT_WIRE_BRAND]: 1,
                status: "ok",
                value: value.value,
            };
        }
        const error = value.error;
        if (error instanceof Error) {
            return {
                [RESULT_WIRE_BRAND]: 1,
                status: "error",
                error: {
                    name: error.name,
                    message: error.message,
                    _tag: error._tag,
                },
            };
        }
        return {
            [RESULT_WIRE_BRAND]: 1,
            status: "error",
            error,
        };
    },
    deserialize(value) {
        if (typeof value === "object" &&
            value !== null &&
            RESULT_WIRE_BRAND in value &&
            value[RESULT_WIRE_BRAND] === 1 &&
            "status" in value) {
            const envelope = value;
            if (envelope.status === "ok") {
                return Result.ok(envelope.value);
            }
            const maybeError = envelope.error;
            if (typeof maybeError === "object" &&
                maybeError !== null &&
                "message" in maybeError) {
                const errorRecord = maybeError;
                const tagged = new TaggedError(typeof errorRecord._tag === "string"
                    ? errorRecord._tag
                    : typeof errorRecord.name === "string"
                        ? errorRecord.name
                        : "RemoteError", typeof errorRecord.message === "string"
                    ? errorRecord.message
                    : "Unknown error");
                return Result.err(tagged);
            }
            return Result.err(maybeError);
        }
        throw new Error("Not a serialized DemoResult");
    },
};
export function isResult(value) {
    return (typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "ok" ||
            value.status === "error"));
}
