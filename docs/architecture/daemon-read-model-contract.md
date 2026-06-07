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
| `feed.rollups` | `/api/feed` | Derived rollups over native domain events; raw envelopes stay behind drilldown pointers |
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
