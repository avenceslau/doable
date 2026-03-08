# Transform Examples

These examples are small, copy/paste-ready transform recipes built with
`@avenceslau/doable`.

## Included examples

- `retry-caller.ts` — caller retries with optional backoff.
- `rate-limit-caller.ts` — caller-side rate limit with `better-result`.
- `auth-guard-callee.ts` — callee auth/policy gate.
- `single-inflight-callee.ts` — callee dedupe for concurrent identical calls.
- `observability-context.ts` — caller + callee timing with `context` propagation.
- `better-result-codec.ts` — caller + callee codec for `better-result`.
- `error-boundary-caller.ts` — caller maps known failures to typed results.

## Usage reminders

- Caller transforms go on stubs via `stub.with(...)`.
- Callee transforms go on classes via `useDOTransforms(MyDO).with(...).done()`.
- For split params in `createTransform`, use:
  - `.callerConfig(...)` for caller side
  - `.calleeConfig(...)` for callee side
