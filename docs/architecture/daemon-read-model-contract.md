# Daemon Read Model Contract

Status: bridge-era contract for `forge-vtq4`.

The native runtime target remains `xt daemon` serving `~/.xtrm/state.db` over
`~/.xtrm/state.sock`. Console continues to call HTTP APIs; it does not open
SQLite and does not own runtime writes.

The typed source of truth for this contract is
`packages/core/src/state/read-models.ts`.

## Console Surfaces

| Contract | Current routes | Replacement source |
|---|---|---|
| `substrate.issue-graph` | `/api/substrate/projects*` | Native issue and edge state, currently bridged by `substrate_*` tables |
| `specialists.activity-evidence` | `/api/specialists/*` | Native specialist job/activity/evidence state, currently bridged by `specialist_*` plus forensic/evidence rows |
| `feed.rollups` | `/api/feed` | Core-owned bridge read model via `@xtrm/core/state` `readFeedPage`; future daemon source is derived rollups over native domain events; raw envelopes stay behind drilldown pointers |
| `graph.console-joins` | `/api/console/graph` | Derived graph projection joining issues, edges, and specialist activity |
| `source-health.freshness` | `/api/sources`, connection, graph, specialists health | Native source freshness with degraded-but-readable semantics |

## Retirement Rules

- Preserve opaque IDs. Do not introduce cross-domain foreign-key assumptions.
- Preserve feed cursor ordering by `t_unix_ms`, `seq`, and `id`.
- Preserve source-health degradation semantics while stale read models remain
  queryable.
- Keep GitHub adapter state separate. `github_*` tables are durable external
  adapter state, not temporary Beads/Specialists bridge cleanup.
- Bridge fields may be dropped only after their replacement contract is served
  by the daemon and current API contract tests stay green.

## Retirement Gate

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

## Current State

| Contract | Core owner | App wrapper | Bridge state still retained |
|---|---|---|---|
| `feed.rollups` | `packages/core/src/state/feed-read-model.ts` owns row selection, severity/redaction normalization, drilldown pointers, and opaque cursor encoding by `(t_unix_ms, seq, id)` | `apps/gitboard/src/api/routes/feed.ts` parses HTTP query parameters and returns the existing `{ rows, cursor }` DTO | `xtrm_forensic_events`, `xtrm_evidence_refs`, `substrate_issues`, and `github_events` remain the bridge/durable adapter inputs until daemon-native rollups are served |
| `source-health.freshness` | `packages/core/src/state/source-health.ts` owns the canonical health vocabulary and freshness mapping; `packages/core/src/runtime/source-lifecycle.ts` defines discovery/health service contracts | `apps/gitboard` still owns current scanner/watcher implementations and source-health route projection | `sources`, `materialization_state`, scanner attach/skip logs, and existing degraded-but-readable DTOs remain retained until source lifecycle services move behind parity tests |
