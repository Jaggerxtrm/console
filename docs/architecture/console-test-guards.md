# Console test guards

## Standard gate

```bash
bun run --cwd packages/core test
bun run --cwd apps/console test
bun run lint
bun run build
bun test tools/retirement/host-retirement-guard.test.ts
bun run tools/retirement/host-retirement-guard.ts --mode strict
```

Run GitNexus upstream impact before symbol changes and
`gitnexus detect-changes --scope compare --base-ref main` before each PR.

## Host and API

```bash
bun run --cwd apps/console smoke:host
bun run --cwd apps/console smoke:api-contract
bun run --cwd apps/console smoke:lifecycle
```

These use temporary databases, roots, logs, and ports. They must never point to
production state.

## Realtime and terminal

```bash
bun run --cwd apps/console smoke:realtime
bun run --cwd apps/console smoke:terminal
```

Realtime covers handshake, subscription, replay, reconnect, malformed input,
valid token, and hostile origin. Terminal covers disabled default, positive
test-token lifecycle, forbidden origin/cwd/shell, rate limits, TTL cleanup,
redaction, and unauthenticated no-leak.

## Deployment

Use the 12-sample 60-minute observation procedure in `docs/deployment.md` after
each production deployment. Any restart, OOM, health/static failure, repeated
API `5xx`, stale materializer, hostile-origin acceptance, or terminal leak is a
HOLD.
