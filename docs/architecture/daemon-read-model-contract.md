---
version: 1
updated: 2026-07-23
synced_at: b569390
---

# Daemon Read Model Contract

Status: bridge-era contract for `forge-vtq4`.

Claim labels:
- implemented-now: live app/core behavior already shipped.
- target-state: daemon/core ownership still migrating.
- blocked: replacement or retirement not yet allowed.
- gate-required: parity/readiness gate must pass first.

The native runtime target remains `xt daemon` serving `~/.xtrm/state.db` over
`~/.xtrm/state.sock`. Console continues to call HTTP APIs; it does not open
SQLite and does not own runtime writes.

The typed source of truth for this contract is
`packages/core/src/state/read-models.ts`.

### forge-3dm4.3 source-lifecycle slice (implemented-now)

Core now owns the source lifecycle policy helpers used by app adapters:
- `formatSourceDisplayPath`
- `createSourceRefreshState`
- `canRefreshSources`
- `normalizeLegacySourceStatus`
- `getMissingDiscoveredSourceKeys`
- `summarizeSourceRefresh`
- `decideBeadsSourceRead`
- `buildBeadsSourceHealthEvent`
- `buildSourceHealthChangedPayload`

`apps/console` owns the runtime adapters for:
- `ProjectScanner` traversal
- `UnifiedScanner` scan/SQL orchestration
- `BeadsChangeWatcher` watch/poll/publish loop
- route DTO assembly and route mounting

Public routes and DTOs are unchanged; only lifecycle decision helpers moved.

### forge-3dm4.5 realtime/log runtime slice (implemented-now)

Core now owns the realtime and log delivery protocol contracts used by app
adapters:
- `REALTIME_PROTOCOL_VERSION`
- realtime channel, message, envelope, subscriber, and registry interfaces
- log level/component/entry types
- `makeLogEntry`
- logger runtime ring, subscriptions, level filtering, disk retention/write queue, and optional publisher hook

`apps/console` owns websocket upgrade handling,
`ChannelRegistry` replay buffers, `WsHandler` connection lifecycle, logger env
configuration and ChannelRegistry adaptation, request logging, and internal log
HTTP DTOs.

This slice does not change read-model ownership or daemon bridge readiness; it
removes app ownership of shared realtime/log protocol shapes and reusable logger runtime policy.

### forge-3dm4.6 terminal/shell policy contract slice (implemented-now)

Core now owns the terminal shell safety policy contracts used by app adapters:
- shell provider policy/status/access context types
- shell-capable provider kind and permission helpers
- shell provider env parsing and enabled/disabled decision helpers
- shell websocket path/origin and admin-token verification helpers

`apps/console` owns Bun websocket upgrades,
`TerminalBridge` connection/session state, local PTY spawning, specialist-feed
process wiring, route DTOs, timers, and cleanup.

This slice does not change read-model ownership or daemon bridge readiness; it
only removes app ownership of pure terminal/shell policy decisions.

### Host cleanup gate (completed)

Host wrapper retirement completed independently of bridge-table retirement.
The bridge-readiness probe remains:

```json
{
  "ready": false,
  "action": "retain",
  "missingContracts": [
    "feed.rollups",
    "graph.console-joins",
    "source-health.freshness"
  ]
}
```

No bridge table or daemon read-model contract was retired by the host migration.
Console owns route DTO adapters, `/console`, WebSockets, terminal, and internal
logs; `/gitboard` remains only as a permanent redirect.

## Console Surfaces (implemented-now / target-state / gate-required)

| Contract | State | Current routes | Replacement source |
|---|---|---|---|
| `substrate.issue-graph` | target-state, gate-required | `/api/substrate/projects*` | Native issue and edge state, currently bridged by `substrate_*` tables |
| `specialists.activity-evidence` | target-state, gate-required | `/api/specialists/*` | Native specialist job/activity/evidence state, currently bridged by `specialist_*` plus forensic/evidence rows |
| `feed.rollups` | implemented-now, target-state | `/api/feed` | Core-owned bridge read model via `@xtrm/core/state` `readFeedPage`; future daemon source is derived rollups over native domain events; raw envelopes stay behind drilldown pointers |
| `graph.console-joins` | target-state, gate-required | `/api/console/graph` | Derived graph projection joining issues, edges, and specialist activity |
| `source-health.freshness` | implemented-now, gate-required | `/api/sources`, connection, graph, specialists health | Native source freshness with degraded-but-readable semantics |

## Final Migration Requirement (gate-required)

`forge-3dm4` makes the remaining read-model extraction explicit: substrate,
specialists, graph, and source-health query services move into
`packages/core/src/state` before their app SQL/query wrappers are retired.
`apps/console` keeps the public routes mounted while route modules adapt HTTP
parameters and DTOs to core-owned services.

Every read-model slice must add route-to-core parity before wrapper retirement.
The parity gate is mandatory for `/api/substrate/*`, `/api/specialists/*`,
`/api/console/graph`, and `/api/sources` plus source-health projections used by
graph and specialists.

## Retirement Rules

- Preserve opaque IDs. Do not introduce cross-domain foreign-key assumptions.
- Preserve feed cursor ordering by `t_unix_ms`, `seq`, and `id`.
- Preserve source-health degradation semantics while stale read models remain
  queryable.
- Keep GitHub adapter state separate. `github_*` tables are durable external
  adapter state, not temporary Beads/Specialists bridge cleanup.
- Bridge fields may be dropped only after their replacement contract is served
  by the daemon and current API contract tests stay green.

## Retirement Gate (blocked)

`packages/core/src/state/bridge-retirement.ts` is the current cleanup gate.
It intentionally returns `retain` until all required Console contracts are
served by `xt daemon`/`state.db`:

- `substrate.issue-graph`
- `specialists.activity-evidence`
- `feed.rollups`
- `graph.console-joins`
- `source-health.freshness`

Retained bridge surfaces are the Beads/Substrate projection
(`substrate_*`), Specialists observability projection (`specialist_jobs`,
`xtrm_forensic_events`, `xtrm_evidence_refs`), and source-health bridge state
(`sources`, `materialization_state`). Runtime observability, forensic/evidence
contracts, feed drilldowns, websocket hints, and current API DTOs must remain
compatible while those surfaces are retained.

GitHub poller/store tables remain durable external adapter state and are not
part of Beads/Specialists bridge retirement.

`forge-3dm4.8` confirms the current action remains `retain`: Beads/Substrate,
Specialists observability, and source-health bridge state stay in place until
the missing daemon-served contracts above are available and parity-tested.

Host retirement passed its isolated, parity, security, and production
observation gates. Those results do not alter this daemon bridge gate.

## Current State (implemented-now)

| Contract | Core owner | App wrapper | Bridge state still retained |
|---|---|---|---|
| `feed.rollups` | `packages/core/src/state/feed-read-model.ts` owns row selection, severity/redaction normalization, drilldown pointers, and opaque cursor encoding by `(t_unix_ms, seq, id)` | `apps/console/src/server/routes/feed.ts` parses HTTP query parameters and returns the existing `{ rows, cursor }` DTO | `xtrm_forensic_events`, `xtrm_evidence_refs`, `substrate_issues`, and `github_events` remain the bridge/durable adapter inputs until daemon-native rollups are served |
| `source-health.freshness` | `packages/core/src/state/source-health.ts` owns the canonical health vocabulary, helper, and freshness mapping; `packages/core/src/runtime/source-lifecycle.ts` defines discovery/health service contracts | Console scanner/watcher implementations and source route projection own runtime reads | `sources`, `materialization_state`, scanner attach/skip logs, and existing degraded-but-readable DTOs remain retained until source lifecycle services move behind parity tests |

## Non-Retirable Until Daemon Served (blocked)

These bridge surfaces remain non-retirable until
`evaluateBridgeRetirementReadiness` returns ready for every contract:

- Beads/Substrate projection tables backing issue graph, graph joins, and feed
  drilldowns;
- Specialists observability projection tables backing activity/evidence,
  forensic feed events, graph joins, websocket hints, and feed rollups;
- source-health bridge state backing degraded-but-readable API responses.
