# Console backend

Status: current production reference.

## Ownership

- `apps/console/src/server/index.ts` is the Bun entrypoint.
- `apps/console/src/server/host.ts` composes HTTP, realtime, terminal, scanner,
  watcher, materializer, poller, and shutdown lifecycle.
- `apps/console/src/server/routes/` owns HTTP adapters and write-policy gates.
- `apps/console/src/server/ws/` owns Bun upgrade handling and protocol adapters.
- `apps/console/src/server/terminal/` owns the PTY boundary.
- `packages/core/src/` owns reusable state, materializer, runtime, GitHub,
  observability, and terminal contracts.

Console is the only runtime writer for an `xtrm.sqlite` database. A kernel-held
writer lease prevents a second host from starting against the same state.

## State

`XTRM_DATA_DIR` selects the state directory and defaults to
`~/.agent-forge`. `GITBOARD_DATA_DIR` remains accepted only as an environment
compatibility fallback; it does not select another implementation or schema.
No migration in the host-retirement work relocates or resets data.

The primary database remains `xtrm.sqlite`. Existing migrations, durable GitHub
state, materialization cursors, source health, forensic events, evidence refs,
and write controls are preserved.

## HTTP and realtime

The supported public surface is `/console`, `/health`, and the existing
`/api/*` and WebSocket protocols. `/gitboard` and old asset paths intentionally
return a permanent `308` redirect to `/console`; no legacy bundle is served.

Write routes remain protected by same-origin/admin proof. Internal verification
is interval-bounded and streams date-pruned logs instead of reading the log
directory into memory. Terminal defaults to disabled/no-leak and retains origin,
token, cwd, shell, rate, and TTL enforcement.

## Validation

```bash
bun run --cwd packages/core test
bun run --cwd apps/console test
bun run lint
bun run build
bun run --cwd apps/console smoke:api-contract
bun run --cwd apps/console smoke:lifecycle
bun run --cwd apps/console smoke:realtime
bun run --cwd apps/console smoke:terminal
bun run tools/retirement/host-retirement-guard.ts --mode strict
```

See `docs/deployment.md` for isolated staging, production observation, and
rollback-window rules.
