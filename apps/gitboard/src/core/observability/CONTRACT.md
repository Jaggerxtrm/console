# Observability contract

Downstream code MUST emit through typed bus.

## Required events
- `materializer.run` — info on start/finish span, error on throw.
- `materializer.snapshot` — info for snapshot read/write/diff compute, error on failure.
- `adapter.cursor.*` — info for cursor advance/reconcile, warn on retry, error on failure.
- `parity.diff` — info for diff compute, warn for threshold breach, error on failure.
- `ws.publish.*` — info for publish success, warn for backpressure/drop, error on failure.
- `api.request.*` — info for request span completion, warn on 4xx/slow, error on 5xx/throw.
- `scanner.*` — info for scan cycle, warn on stale/lag, error on failure.
- `app.*` — info for lifecycle transitions, error for fatal exit paths.
- legacy component-tagged events — must continue to pass through unchanged until migrated.

## Severity rules
- `info`: normal lifecycle and span completion.
- `warn`: retry, slow path, threshold breach, degraded state.
- `error`: thrown error, failed publish, failed request, failed scan, fatal lifecycle.
