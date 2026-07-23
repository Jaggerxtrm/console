# Console architecture

Status: current after host retirement.

## Runtime boundary

`apps/console` is both the production host and UI package. The composition root
at `apps/console/src/server/index.ts` creates one host, one writer lease, and one
lifecycle for the selected state directory.

| Surface | Owner | Contract |
|---|---|---|
| Bun HTTP/static host | `apps/console/src/server` | `/health`, `/console`, `/api/*`, legacy redirects |
| HTTP adapters and write gates | `apps/console/src/server/routes` | Existing DTOs, status codes, pagination, admin/same-origin checks |
| Realtime and replay | `apps/console/src/server/ws` + Core contracts | Existing handshake, subscription, replay, reconnect, origin/token policy |
| Terminal | `apps/console/src/server/terminal` + Core policy/provider contracts | Disabled default, no-leak, allowlists, rate and TTL cleanup |
| Runtime lifecycle | `apps/console/src/server/runtime` | Scanner, refresh, watcher, materializer, parity, poller, shutdown |
| Durable state and materializer logic | `packages/core/src/state`, `packages/core/src/materializer` | Existing SQLite files, migrations, cursors, atomic commits |
| GitHub adapter | `packages/core/src/github` with Console route/poller wiring | Durable state, cache/fallback, polling behavior |
| Dashboard | `apps/console/src/dashboard` | Issues, Graph, Specialists, GitHub, Explore, Operations, Observability |

## State and writer safety

`XTRM_DATA_DIR` is primary; `GITBOARD_DATA_DIR` is an environment compatibility
fallback only. The state schema is not relocated or reset. A per-database
runtime writer lease fails closed when another process already owns the state.
Materialization commits data and cursors atomically, then publishes realtime
hints after commit.

## Degraded behavior

Missing or temporarily unavailable sources do not make the entire host
unreadable. Source health exposes degradation, cached/materialized reads remain
available where valid, and scanner discovery misses are counted separately from
runtime failures.

## Security boundary

Write operations require admin/same-origin proof. Realtime and terminal upgrades
enforce origin and token policy. Terminal providers preserve cwd/shell
allowlists, environment scrubbing, child caps, rate limits, hard/idle TTLs, and
unauthenticated no-leak behavior. Structured logs redact private paths, tokens,
and raw terminal payloads.

## Compatibility

`/gitboard`, `/gitboard/*`, and old asset paths return `308` to `/console`.
This is URL compatibility, not a second application. The guard in
`tools/retirement/host-retirement-guard.ts` prevents production paths from
depending on the retired package or package name.
