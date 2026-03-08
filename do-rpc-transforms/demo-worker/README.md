# do-rpc-transforms demo worker

This is a deployable Cloudflare Worker + Durable Object demo for
`@avenceslau/doable`.

## Local dev

From `do-rpc-transforms/`:

```bash
npm run demo:dev
```

Try:

- `GET /demo?name=Ada`

Response contains:

- `ok`: success flag
- `result` on success (from `DemoDO.greet(...)`)
- `error` on rate-limited calls (`RateLimitError` via Result codec)
- `meta`: metadata captured by a callee transform, including
  `__doRpcTransformsCallId`

Demo behavior:

- Uses a Result `codec` transform (caller + callee, better-result style)
- Uses callee-side rate limiting on `greet`
- Limit: 3 calls per 10s window
- Demonstrates `createTransform` with different caller/callee params
- Uses `useDOTransforms(...).with(...).done()` to finalize typed DO outputs

## Deploy

From `do-rpc-transforms/`:

```bash
npm run demo:deploy
```
