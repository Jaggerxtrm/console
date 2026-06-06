# Gitboard Backend Architecture

Status: current backend reference for the running `apps/gitboard` service.

Documentation entrypoint: `docs/READ_THIS_FIRST.md`.

This document describes the post-bridge backend shape. Older Beadboard-era
details have been removed from the current-state narrative. Historical redesign
context lives in `docs/backend-redesign.md`; architectural ownership
(UI/API/materializer/state, telemetry materialization, current repo state,
dormant tooling) lives in `docs/architecture/console-architecture.md`.

<!-- INDEX:START -->
## Index
- [Runtime Overview](#runtime-overview)
- [Process Startup](#process-startup)
- [Directory and Module Map](#directory-and-module-map)
- [Configuration and Environment](#configuration-and-environment)
- [Hono App Composition](#hono-app-composition)
- [State Store](#state-store)
- [Materializer Bridge](#materializer-bridge)
- [API Surface](#api-surface)
- [GitHub Adapter](#github-adapter)
- [Beads/Substrate Bridge](#beadssubstrate-bridge)
- [Specialist Observability](#specialist-observability)
- [Feed And Graph](#feed-and-graph)
- [WebSocket Channels](#websocket-channels)
- [Terminal And Shell Backend](#terminal-and-shell-backend)
- [Operations And Diagnostics](#operations-and-diagnostics)
- [Testing And Verification](#testing-and-verification)
- [Known Sharp Edges](#known-sharp-edges)
<!-- INDEX:END -->

## Runtime Overview

Gitboard is currently the only running service. It is a native Bun process
under `apps/gitboard` that combines:

1. A Hono HTTP API.
2. Static dashboard serving under `/gitboard`.
3. A WebSocket hub for dashboard realtime invalidation and logs.
4. A terminal WebSocket bridge for optional local shell sessions.
5. A local `xtrm.sqlite` bridge store in `GITBOARD_DATA_DIR`.
6. A background materializer for Beads/Substrate-shaped rows and Specialists
   observability rows.
7. A durable GitHub adapter/poller/store for remote GitHub state.

The app name remains Gitboard in this tranche. Console is the product target,
but route rename, package rename, visual redesign and broad string cleanup are
owned by later migration work.

Production target used during current operations:

```text
Service: systemd --user gitboard.service
URL:     http://100.113.49.52:3030/gitboard
Console: http://100.113.49.52:3030/gitboard/console
Runtime: native Bun, not Docker Compose
```

## Process Startup

Entry point: `apps/gitboard/src/index.ts`.

Current startup sequence:

```ts
const DATA_DIR = process.env.GITBOARD_DATA_DIR ?? `${process.env.HOME}/.agent-forge`;
const GITBOARD_DB_PATH = join(DATA_DIR, "gitboard.sqlite");
const XTRM_DB_PATH = join(DATA_DIR, "xtrm.sqlite");
const PORT = Number(process.env.PORT ?? 3030);

const xtrmDb = createXtrmDatabase(XTRM_DB_PATH);
foldGitboardSQLite(GITBOARD_DB_PATH, xtrmDb);
startServer(xtrmDb, { port: PORT });
```

`gitboard.sqlite` is legacy input. When present, `foldGitboardSQLite` folds old
GitHub tables into `xtrm.sqlite`. Runtime reads and new writes use `xtrm.sqlite`.

After the server starts, the GitHub poller discovers repos, backfills events and
starts polling unless `SKIP_GITHUB_POLLER=1`.

## Directory and Module Map

```text
apps/gitboard/src/index.ts                       Native Bun entrypoint
apps/gitboard/src/api/server.ts                  Hono app composition + websocket upgrade
apps/gitboard/src/api/routes/*.ts                HTTP API route modules
apps/gitboard/src/api/ws/channels.ts             Channel registry + replay buffer
apps/gitboard/src/api/ws/handler.ts              Dashboard websocket protocol
apps/gitboard/src/api/terminal/*.ts              Terminal provider registry + bridge
apps/gitboard/src/core/xtrm-store.ts             xtrm.sqlite schema and migrations
apps/gitboard/src/core/migrations/*.ts           Legacy store fold migrations
apps/gitboard/src/core/materializer/*.ts         Materializer core and adapters
apps/gitboard/src/core/github-store.ts           GitHub DAO
apps/gitboard/src/core/github-poller.ts          GitHub polling + realtime publication
apps/gitboard/src/core/github-discover.ts        GitHub repo discovery
apps/gitboard/src/core/project-scanner.ts        Beads project discovery
apps/gitboard/src/core/dolt-client.ts            Dolt SQL client
apps/gitboard/src/core/graph-dao.ts              Graph cache + graph builder
apps/gitboard/src/core/logger.ts                 JSONL logs + websocket log fanout
apps/gitboard/src/core/shell-provider-policy.ts  Shell/terminal access policy
apps/gitboard/src/server/beads/*.ts              Beads trigger watcher
apps/gitboard/src/server/observability/*.ts      Specialists observability registry/watcher/DAO
```

There is no load-bearing top-level Beadboard app in the current tree. Legacy
`/api/beads` route code may still exist in `apps/gitboard/src/api/routes`, but
`apps/gitboard/src/api/server.ts` does not mount `/api/beads`.

## Configuration and Environment

Core runtime variables:

| Variable | Used by | Default | Meaning |
|---|---|---:|---|
| `GITBOARD_DATA_DIR` | `index.ts` | `~/.agent-forge` | Directory for `xtrm.sqlite` and legacy `gitboard.sqlite` |
| `PORT` | `index.ts` / `startServer` | `3030` | HTTP port for native service; Docker overrides to `3000` |
| `HOST` | `startServer` | production `0.0.0.0`, otherwise `127.0.0.1` | Bind host |
| `LOG_DIR` | logger/internal logs | `~/.xtrm/logs` or app logs fallback | JSONL log directory |
| `GITBOARD_LOG_DIR` | logger | app logs fallback | Legacy log env name |
| `XDG_PROJECTS_DIR` | scanners/Dolt host logic | scanner-specific | Root for project discovery |
| `DOLT_HOST` | graph/Dolt clients | `127.0.0.1` or container fallback | Dolt SQL host |
| `GITHUB_TOKEN` | GitHub poller/discovery/readme | none | Enables authenticated GitHub API calls |
| `GITHUB_OWNER` | GitHub discovery | `Jaggerxtrm` | Owner for discovered repos |
| `SKIP_GITHUB_POLLER` | `index.ts` | unset | Disable GitHub poller when set to `1` |
| `GITBOARD_ENABLE_PARITY` | server parity harnesses | unset | Enable shadow parity diagnostics |
| `GITBOARD_SPECIALISTS_LIVE_FALLBACK` | specialists route | unset | Allow live observability fallback after xtrm path is active |
| `GITBOARD_ALLOW_LOCAL_SHELL` | shell policy | `false` | Enables local terminal provider |
| `GITBOARD_SHELL_ADMIN_TOKEN` | shell policy | none | Required token for non-loopback shell access |
| `GITBOARD_SHELL_ALLOWED_ORIGINS` | shell policy | localhost/Tailscale defaults | Comma-separated allowed origins |

`forge-benk.6` owns normalization of port and env naming drift.

## Hono App Composition

`apps/gitboard/src/api/server.ts` is the runtime composition root. It creates:

- `ChannelRegistry`
- `WsHandler`
- `Materializer`
- `UnifiedScanner`
- Beads `TriggerWatcher`
- Specialists observability watcher
- optional parity harnesses
- terminal bridge and provider registry

Mounted routes:

```ts
app.get("/health", ...);
app.route("/api/github", createGithubRouter(storeDb, registry));
app.route("/api/substrate", createSubstrateRouter(xtrmDb ?? null));
app.route("/api/specialists", createSpecialistsRouter(undefined, xtrmDb));
app.route("/api/console/observability", createObservabilityRouter(undefined, xtrmDb));
app.route("/api/console/graph", createGraphRouter(...));
app.route("/api/feed", createFeedRouter(xtrmDb ?? null));
app.route("/api/sources", createSourcesRouter(xtrmDb ?? null, currentUnifiedScanner));
app.route("/api/console/shell", createShellRouter());
app.route("/api/console/terminal", createTerminalRouter());
app.route("/api/internal", createInternalDoltHealthRouter());
app.route("/api/internal", createInternalLogsRouter());
app.route("/api/internal", createInternalSubstrateRouter(xtrmDb ?? null));
app.route("/api/internal", createInternalVerifyRouter());
app.route("/api/internal", createInternalParityRouter());
```

`/api/beads` is not mounted. `/beadboard` is not a current compatibility app
surface; smoke coverage expects it to remain retired/404 unless a deliberate
compatibility bead reopens it.

## State Store

Current store: `xtrm.sqlite`, created by
`apps/gitboard/src/core/xtrm-store.ts`.

Logical table families:

- `github_*`: durable local adapter state for remote GitHub.
- `substrate_*`: Beads/Substrate-shaped bridge/projection rows. These are not
  the future native Substrate schema.
- `specialist_*`: materialized Specialists job state and compatibility job
  events.
- `xtrm_forensic_events` and `xtrm_evidence_refs`: generic forensic/evidence
  state.
- `substrate_job_link`: job-to-issue bridge link.
- `sources`: discovered source registry.
- `materialization_state`: per-source cursor, last success and last error.

The ownership contract is documented in
`docs/architecture/console-architecture.md`.

## Materializer Bridge

The materializer lives in `apps/gitboard/src/core/materializer`.

Responsibilities:

- own per-source cursors;
- call source adapters;
- write bridge state in transactions;
- write `materializer.*` forensic events;
- advance `materialization_state`;
- emit websocket hints only after commit.

Current source families:

- `obs:<repoSlug>`: Specialists observability DBs via
  `createObservabilityAdapter`.
- `beads:<projectId>`: Beads/Substrate-shaped issue graph via Beads adapters
  and trigger watcher.

The materializer owns bridge writes. API routes should read materialized state
and project DTOs; they should not advance cursors or write bridge tables on
ordinary reads.

## API Surface

Current public API groups:

```text
GET /health
/api/github/*
/api/substrate/*
/api/specialists/*
/api/console/observability/*
/api/console/graph*
/api/feed
/api/sources/*
/api/console/shell/*
/api/console/terminal/*
/api/internal/*
```

API routes are read/projector surfaces with route-local caches and explicit
admin-gated invalidation where needed. Direct UI calls to source stores are not
part of the integration model.

## GitHub Adapter

GitHub is a durable external adapter, not a temporary Beads/Substrate bridge.

Key files:

```text
apps/gitboard/src/api/routes/github.ts
apps/gitboard/src/core/github-store.ts
apps/gitboard/src/core/github-poller.ts
apps/gitboard/src/core/github-discover.ts
apps/gitboard/src/core/github-readme.ts
```

The poller fetches GitHub events, PRs, issues and releases with ETag/304
support, writes `github_*` tables, and publishes dashboard hints/events through
the channel registry.

## Beads/Substrate Bridge

`/api/substrate` is the current Beads bridge API over materialized
`substrate_*` rows.

Primary endpoints:

```text
GET /api/substrate/projects
GET /api/substrate/projects/:projectId/issues
GET /api/substrate/projects/:projectId/issues/closed
GET /api/substrate/projects/:projectId/issues/:issueId
GET /api/substrate/projects/:projectId/memories
GET /api/substrate/projects/:projectId/interactions
GET /api/substrate/projects/:projectId/runtime-graph
GET /api/substrate/projects/:projectId/stats
GET /api/substrate/projects/:projectId/connection
```

The `substrate_*` table names are legacy bridge/projection names. Native
Substrate, when it lands, should be read through its daemon/API plus a
last-successful cache. Console should not copy native Substrate into another
SQLite projection.

## Specialist Observability

Primary path:

1. Specialists writes upstream observability DBs.
2. `createObservabilityAdapter` reads `specialist_forensic_events` and
   `specialist_job_metrics` when available, with legacy event fallback.
3. Materializer writes `specialist_jobs`, `xtrm_forensic_events` and
   `xtrm_evidence_refs` into `xtrm.sqlite`.
4. `/api/specialists` serves job lists, chain detail and canonical forensic
   feed events from materialized state.

Mounted routes:

```text
GET /api/specialists/jobs?bead_id=<id>
GET /api/specialists/jobs/in-flight?limit=<n>&repo_slug=<slug>
GET /api/specialists/chains/:chain_id
GET /api/specialists/jobs/:job_id/result
GET /api/specialists/jobs/:job_id/feed
GET /api/specialists/jobs/:job_id/feed-events
```

`/jobs/:job_id/feed-events` is canonical-envelope-first and ordered by
`(t_unix_ms, seq)`. It preserves upstream redaction/correlation/body/trace/link
semantics after transport sanitization.

The live attach fallback is compatibility only. New Console data should flow
from upstream telemetry into materialized state, then through API DTOs.

## Feed And Graph

`/api/feed` is a cursor-paginated display rollup over materialized Specialists,
Beads/Substrate, GitHub and materializer rows. It carries display fields and
drilldown pointers, not raw forensic envelopes.

`/api/console/graph` is a graph view over materialized Beads/Substrate issue
rows plus Specialists overlays. It supports `project` or `project_id`,
`include_closed=true`, and protected invalidation.

Guard fixtures:

```text
apps/gitboard/tests/fixtures/api-feed-rollup-contract.json
apps/gitboard/tests/api/feed-rollup-contract.test.ts
apps/gitboard/tests/api/routes/graph.xtrm.test.ts
```

## WebSocket Channels

Channel registry: `apps/gitboard/src/api/ws/channels.ts`.

Current channel families include:

```text
github:activity
github:repo:${repo}
substrate:changes
substrate:project:${projectId}
specialists:activity
specialists:repo:${repoSlug}
session:${id}
output:${id}
messages
protocol:${id}
system
```

The materializer publishes `specialists:sync_hint` and `substrate:sync_hint`
after commit. HTTP/local DB reads remain authoritative; websocket events are
invalidation hints for persisted surfaces. Logs and terminal streams remain
live/transient streams.

## Terminal And Shell Backend

Routes:

```text
GET /api/console/shell/status
GET /api/console/terminal/providers
WebSocket /api/console/terminal/ws/:provider
```

`TerminalBridge` owns terminal session lifecycle. `shell-provider-policy.ts`
keeps the local provider disabled by default and requires loopback or configured
admin/origin checks for non-loopback access.

Security boundary: policy and Tailscale trust, not container isolation.

## Operations And Diagnostics

### Build and restart

```bash
cd apps/gitboard
bun run build:dashboard
systemctl --user restart gitboard
systemctl --user --no-pager --lines=50 status gitboard
```

### Smoke checks

```bash
curl -fsS http://100.113.49.52:3030/health
curl -fsS http://100.113.49.52:3030/gitboard
curl -fsS 'http://100.113.49.52:3030/api/feed?limit=5'
curl -fsS 'http://100.113.49.52:3030/api/console/graph?project_id=gitboard&refresh=true'
curl -fsS 'http://100.113.49.52:3030/api/substrate/projects'
```

### Logs

Default production logs are under:

```text
~/.xtrm/logs/YYYY-MM-DD.jsonl
apps/gitboard/logs/YYYY-MM-DD.jsonl
logs/YYYY-MM-DD.jsonl
```

Useful grep patterns:

```bash
grep -E 'materializer|graph\.|source.degraded|specialists\.|feed' ~/.xtrm/logs/$(date -u +%F).jsonl | tail -200
```

## Testing And Verification

Core cleanup/boundary guards:

```bash
bun run --cwd apps/gitboard typecheck
bun run --cwd apps/gitboard test -- \
  tests/backend-boundaries/console-separation-boundary-contract.test.ts \
  tests/core/materializer.test.ts \
  tests/core/materializer/observability-adapter.test.ts \
  tests/core/materializer/beads-adapter.test.ts \
  tests/core/materializer/beads-snapshot-source.test.ts \
  tests/core/xtrm-store.test.ts
bun run --cwd apps/gitboard test -- \
  tests/api/feed-rollup-contract.test.ts \
  tests/api/routes/feed.test.ts \
  tests/api/routes/specialists.test.ts \
  tests/api/specialists.xtrm.test.ts \
  tests/api/routes/substrate.test.ts \
  tests/api/routes/graph.xtrm.test.ts
bun run --cwd apps/gitboard test -- \
  tests/server/observability/prometheus-cardinality.test.ts
```

Use `docs/architecture/console-test-guards.md` for the complete conditional
guard matrix.

## Known Sharp Edges

1. `apps/gitboard` remains the service/package name until the Console migration
   track performs a deliberate rename.
2. `substrate_*` tables are bridge/projection tables, not native Substrate.
3. `/api/beads` is legacy unmounted code. `forge-benk.10` retired the stale
   cache coverage in favor of `/api/substrate/*`.
4. `/beadboard` is retired. Do not describe it as a current compatibility app
   unless a future compatibility bead reopens it.
5. GitHub is a durable external adapter and should not be deleted with temporary
   Beads/Specialists bridge cleanup.
6. Specialists live fallback is compatibility only; the primary path is
   telemetry → materializer → `xtrm.sqlite` → API.
7. Prometheus labels must stay low-cardinality. Drilldown IDs live in forensic
   and evidence state.
8. Terminal bridge is powerful. Keep shell disabled unless intentionally
   enabled and protected by origin/token checks.
