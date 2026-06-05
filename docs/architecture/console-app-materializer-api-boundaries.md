# Console App, API, And Materializer Boundaries

Status: `forge-benk.3` separation contract, pre-Substrate.

This document turns the telemetry bridge design into an operational boundary
map for post-bridge cleanup and future Console migration work. It complements
`docs/architecture/console-telemetry-materialization.md`, which remains the
telemetry and materialization source of truth.

## Boundary Summary

| Layer | Owns | May read | May write | Must not do |
|---|---|---|---|---|
| Dashboard UI in `apps/gitboard/src/dashboard` | Display state, navigation, drilldown affordances, stale-while-revalidate behavior | Public API DTOs under `/api/*` | Client-only view state and telemetry events | Read `.specialists`, Beads files, Dolt, GitHub, or SQLite directly |
| API composition in `apps/gitboard/src/api/server.ts` | Route mounting, realtime wiring, source scanners, materializer lifecycle | `xtrm.sqlite` through route DAOs and helper modules | Admin-gated invalidation, route-local caches, runtime logs | Put source ingestion logic inside route handlers |
| API routes | DTO projection, auth/admin gating, cursor/pagination, source health | Materialized state tables and low-cardinality summaries | Response-local cache, admin refresh state | Advance materializer cursors, mutate bridge tables, or invent source truth |
| Materializer in `apps/gitboard/src/core/materializer` | Source cursors, idempotent writes, bridge table updates, forensic events, websocket hints after commit | Source adapters and existing materialization cursor state | `substrate_*`, `specialist_*`, `xtrm_forensic_events`, `xtrm_evidence_refs`, `materialization_state` | Serve UI DTOs, own Console taxonomy, or write Prometheus labels |
| GitHub poller/store | Durable local adapter for remote GitHub state | GitHub REST and GitHub state tables | `github_*` tables and poll state | Pretend to be temporary Substrate bridge state |
| Future Substrate daemon/API | Native issue/runtime state ownership | Its own state store and API | Its own state store | Be copied into another SQLite projection by Console |

## Current Composition Root

`apps/gitboard/src/api/server.ts` is the only current runtime composition root.
It creates the `ChannelRegistry`, `Materializer`, `UnifiedScanner`, Beads
trigger watcher, observability watcher, parity harnesses, and terminal bridge.
It mounts the read APIs:

- `/api/github`
- `/api/substrate`
- `/api/specialists`
- `/api/console/observability`
- `/api/console/graph`
- `/api/feed`
- `/api/sources`
- `/api/console/shell`
- `/api/console/terminal`
- `/api/internal/*`

This composition is allowed to wire sources together, but source-specific
ingestion must remain in adapters, pollers, scanners, or materializer sources.
Route handlers should stay read/projector surfaces except for explicitly
admin-gated invalidation or terminal/session actions.

## State Ownership

`xtrm.sqlite` is a bridge read model. Tables named `substrate_*` are legacy
bridge/projection tables for Beads/Substrate-shaped reads, not the future native
Substrate schema.

Current ownership:

- `substrate_issues`, `substrate_dependencies`, `substrate_issue_edges`:
  written by Beads materialization; read by `/api/substrate`,
  `/api/console/graph`, `/api/feed`, and dashboard Beads/Console surfaces.
- `specialist_jobs`, `specialist_job_events`, `xtrm_forensic_events`,
  `xtrm_evidence_refs`, `substrate_job_link`: written by observability
  materialization; read by `/api/specialists`, `/api/feed`, graph joins, and
  specialists drilldowns.
- `materialization_state`: written by `Materializer`; read by route source
  health only.
- `github_*`: written by GitHub adapter/poller/store; read by `/api/github` and
  `/api/feed`.
- `sources`: written by scanner/discovery paths; read by source, substrate, and
  graph routes.

No UI component should bypass these APIs to read source stores directly. No API
route should advance materializer cursor state as part of a user read. No
materializer adapter should format display DTOs for a single route.

## Specialists Boundary

The primary specialists path is:

1. Specialists writes upstream observability state, including
   `specialist_forensic_events` and `specialist_job_metrics` when available.
2. `createObservabilityAdapter` materializes job rows, token metrics, forensic
   envelopes, and evidence refs into `xtrm.sqlite`.
3. `/api/specialists` reads materialized state for job lists, chain detail, and
   `/jobs/:job_id/feed-events`.
4. Dashboard specialists views render API DTOs and compact forensic summaries.

`GITBOARD_SPECIALISTS_LIVE_FALLBACK=1` and the default observability attach
fallback are compatibility paths. They may keep the UI useful before the first
successful materialization, but they must not become the primary integration
path and should not be expanded for new Console features. New specialists data
needed by Console should be added to upstream telemetry, materialized into
bridge state, and projected by the API.

`/api/specialists/jobs/:job_id/feed-events` is canonical-envelope-first. It may
sanitize the envelope shape for transport, but it must preserve upstream
semantics: `schema_version`, `t_unix_ms`, `seq`, `severity`, `event_family`,
`event_name`, `resource`, `correlation`, `body`, `redaction`, `trace`, `links`,
and `diagnostics` where present.

## Beads And Future Substrate Boundary

Before native Substrate lands, Beads remains the Specialists orchestration
graph. The materializer must preserve the typed graph enough for Console to show
real runtime structure:

- issue hierarchy and parent-child links;
- typed dependency/edge relations;
- molecule, step, gate, advisor, reviewer, and formula/template signals;
- labels, metadata, notes, descriptions, and embedded contract XML.

`/api/substrate` is currently a bridge API over those projected rows. It should
be treated as "Substrate-shaped Beads bridge", not as the native Substrate
daemon contract. When native Substrate arrives, Console should prefer live
Substrate daemon/API reads plus a last-successful cache. It should not add a new
SQLite-to-SQLite projection of native Substrate state.

## Feed And Metrics Boundary

`/api/feed` is a display rollup over materialized state. It is not a forensic
firehose and should not expose raw `body`, `correlation`, `trace`, `links`, or
full envelope blobs. Rows carry display fields plus drilldown pointers into
forensic/evidence, Beads/Substrate, GitHub, or materializer state.

Prometheus is lower-level still: a low-cardinality operational projection only.
Concrete identifiers such as job, bead, issue, chain, trace, path, command,
prompt, diff, URL, email, token, or raw error content belong in forensic and
evidence state, never in Prometheus labels.

## Enforcement

Use these guards when a change touches the boundary:

- Layer separation:
  `bun run --cwd apps/gitboard test -- tests/backend-boundaries/console-separation-boundary-contract.test.ts`
- Materializer/state writes:
  `bun run --cwd apps/gitboard test -- tests/core/materializer.test.ts tests/core/materializer/observability-adapter.test.ts tests/core/materializer/beads-adapter.test.ts tests/core/materializer/beads-snapshot-source.test.ts tests/core/xtrm-store.test.ts`
- API projection contracts:
  `bun run --cwd apps/gitboard test -- tests/api/feed-rollup-contract.test.ts tests/api/routes/feed.test.ts tests/api/routes/specialists.test.ts tests/api/specialists.xtrm.test.ts tests/api/routes/substrate.test.ts tests/api/routes/graph.xtrm.test.ts`
- Prometheus/cardinality:
  `bun run --cwd apps/gitboard test -- tests/server/observability/prometheus-cardinality.test.ts`
- Dashboard read-surface regressions:
  `bun run --cwd apps/gitboard test -- tests/dashboard/components/beads/BeadsRepoView.test.tsx tests/dashboard/pages/console/ChainDetailPane.test.tsx tests/dashboard/pages/console/Graph.chip.test.tsx tests/dashboard/pages/console/ia-restructure.test.tsx`

`docs/architecture/post-bridge-cleanup-test-guards.md` remains the complete
command checklist for cleanup work. This document defines the ownership reason
for those guards.

## Follow-Up Ownership

- `forge-benk.6`: normalize runtime environment names and port defaults without
  changing these ownership boundaries.
- `forge-benk.7`: refresh stale backend docs so they describe this boundary
  instead of the retired Beadboard split.
- `forge-benk.8`: remove tracked runtime artifacts without touching bridge
  schema or source ownership.
- `forge-benk.10`: legacy `/api/beads` cache coverage is retired; project reads
  stay on `/api/substrate/*`.
- `forge-szc0`: keep telemetry schema/docs aligned with upstream Specialists
  contracts; this boundary should remain stable while field-level schema docs
  evolve.
