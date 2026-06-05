# xtrm Observability OpenSpec Plan

Status: planning output for `forge-ow7c.2`, pre-implementation.

This document turns `docs/xtrm-observability-prd.md` into a dispatchable planning
shape without starting the UI implementation. It is intentionally a bridge-era
spec: Console consumes infra and specialists telemetry contracts; it does not
define exporters, alert thresholds, or specialist runtime semantics.

## Inputs Read

- `docs/xtrm-observability-prd.md`
- `docs/xtrm-console-visual-contract.md`
- `docs/backend-redesign.md`
- `docs/deployment.md`
- `/home/dawid/projects/mercury/infra/MONITORING.md`
- `/home/dawid/projects/mercury/infra/docs/AGENT_MONITORING.md`
- `/home/dawid/dev/specialists/docs/observability-metrics.md`
- `/home/dawid/dev/specialists/docs/telemetry/*`
- `/home/dawid/dev/specialists/docs/design/substrate/devops-platform-engineering-prd.md`
- `/home/dawid/dev/specialists/docs/design/substrate/substrate.md`
- `/home/dawid/second-mind/1-projects/xtrm/research/*observability*`
- `/home/dawid/second-mind/1-projects/xtrm/research/*telemetry*`
- `/home/dawid/second-mind/1-projects/xtrm/archive/devops-specialists*.md`

External refresh sources checked on 2026-06-06:

- Grafana MCP read-only/tool gating docs.
- OpenTelemetry GenAI and MCP semantic conventions.
- Prometheus metric naming guidance.
- AWS DevOps Agent Task, Recommendation, and JournalRecord APIs.
- AWS AgentCore observability docs.

## Planning Decisions

1. Query proxy: default to server-side proxy for managed/self use.
   Browser-direct is not a Phase 0 path because it leaks credential shape into
   the frontend. A future self-hosted mode may opt into direct datasource
   bindings behind an explicit deployment flag.

2. Dashboard JSON versioning: use strict `schema_version` plus migration
   functions. Specs must remain exportable and replayable; additive-only is too
   weak once agent-authored dashboards exist.

3. Variables: start smaller than Grafana.
   Phase 0 supports named variables, datasource-backed option queries, global
   range, and explicit interpolation. Defer Grafana-compatible magic variables
   such as `__interval` until the datasource contract needs them.

4. Heatmap: defer renderer choice to a spike before Phase 1.
   Phase 0 ships TimeSeries, Stat, and Threshold. The spike should compare uPlot
   plugin support against a small canvas implementation before considering D3.

5. Agent dashboard authoring: operator approval required.
   Agents may emit draft dashboard specs, panel inserts, selected time ranges,
   or references to existing dashboards. Persistent writes require schema
   validation, datasource safety checks, and an explicit operator accept action.

6. Tenancy: single process with tenant-scoped datasource bindings for now.
   Do not design hard process isolation into Phase 0/1. Preserve schema fields
   for tenant id and deployment environment so a later customer mode can split
   process boundaries without rewriting dashboard specs.

7. Logs/traces: model them in the datasource interface from day one.
   Rendering can lag behind metrics, but the contract must already represent
   log evidence, trace/span lookup, evals, alerts, journals, and recommendations
   so Phase 0 does not hard-code a Prometheus-only worldview.

8. Product name: internal surface is `Console Operations`.
   Avoid public naming work in this tranche. `xtrm Observability` remains the PRD
   concept; the running app remains the gradual Console target.

## Capability Slices

### Slice A: Datasource And Evidence Contract

Owner bead: `forge-ow7c.3`.

Output:

- TypeScript contract for datasource descriptors, tenant/env context, query
  request, query response, evidence refs, health, and freshness.
- Signal types: `metric`, `log`, `trace`, `eval`, `alert`, `dashboard`,
  `journal`, `recommendation`, `runbook`, `forensic_event`.
- Safety contract: bounded range, bounded result count, server-side credentials,
  read-only Grafana/MCP posture, low-cardinality labels, high-cardinality IDs in
  evidence/correlation only.

Acceptance:

- Fixture contract can represent Prometheus query results, Grafana deeplinks,
  Loki log evidence, OTel trace/span refs, specialist eval results, and AWS-style
  recommendation/journal records.
- Missing signal paths produce owning-repo follow-up notes, not local fake metrics.

### Slice B: Dashboard Spec Renderer Contract

Owner bead: new child under `forge-ow7c` if implementation starts after planning.

Output:

- JSON dashboard schema with `schema_version`, `tenant`, `datasource`, variables,
  panels, layout, refresh policy, and evidence refs.
- Fixture datasource and snapshot fixtures for tests/previews.
- No live Prometheus dependency in unit tests.

Acceptance:

- Schema validator rejects unknown panel types, unsafe unbounded queries, missing
  datasource ids, and agent-authored writes without approval state.
- Migration test proves `schema_version` can upgrade one fixture.

### Slice C: AgentOps Panels

Owner bead: `forge-ow7c.4`.

Output:

- Panel specs for specialist job state, wait/duration, turns/tools/model, token
  split, MCP error/session latency, eval pass rate, policy/auth evidence, and
  process/worktree health.
- Upstream mapping to specialists telemetry docs.

Acceptance:

- No USD display unless backed by versioned pricing or billing provenance.
- Token split uses canonical input/output/cache/reasoning/tool categories where
  upstream exposes them.

### Slice D: Source Health And Dolt Evidence

Owner bead: `forge-ow7c.5`.

Output:

- Replace bespoke source-health shapes with datasource-backed evidence panels.
- Map Mercury infra signals: Prometheus targets, cAdvisor/node exporter, Loki
  labels, alert rules, backup freshness, Docker health files.

Acceptance:

- Container/host metrics are marked infra evidence, not app-health truth.
- Service-level RED/SLI signals remain preferred when available.

### Slice E: Operator Evidence UX

Owner bead: `forge-ow7c.6`.

Output:

- UX contract for panel drilldowns, alert evidence, runbook links, Grafana
  deeplinks, query text, trace/span ids, redaction status, and last-successful
  cache status.
- Agent-authored panel insert flow.

Acceptance:

- UI preserves upstream names exactly for metrics, labels, alert names, dashboard
  titles, and datasource ids.
- Every panel can expose copyable query/evidence metadata without visual redesign.

### Slice F: Journal And Recommendation Promotion

Owner bead: `forge-ow7c.7`.

Output:

- Mapping from DevOps journal/recommendation records to Console surfaces and
  substrate class semantics.
- Promotion rules:
  - non-blocking ops advice -> `followup`
  - current-chain safety blocker -> `gate` or escalation
  - pre-work guidance -> `advisor`
  - accepted standalone work -> `root`

Acceptance:

- Recommendation status/rank/approval state remains visible.
- Journals stay timeline/evidence; they do not become issue graph nodes by
  default.

## Deferred Implementation Beads

These should be created only when `forge-ow7c.3` finishes the contract:

- Implement datasource contract and fixture datasource in `apps/console`.
- Implement dashboard schema validator and migration fixture.
- Implement Phase 0 panel primitives: TimeSeries, Stat, Threshold.
- Implement first static dashboard pack using fixture data.
- Add datasource safety tests for forbidden labels and unbounded queries.
- Add agent-authored dashboard approval fixture tests.

## Cross-Repo Dependencies

- `mercury/infra`: owns Prometheus, Grafana, Loki, Alertmanager, exporters, alert
  rules, scrape targets, Terraform/IaC, and future query MCP.
- `specialists`: owns specialist runtime telemetry, forensic events, Prometheus
  projection, MCP/tool semantics, eval semantics, and policy/identity evidence.
- `gitboard`/Console: owns product surface, datasource client contracts, panel
  rendering, dashboard JSON, evidence drilldowns, and operator approval UX.
- Substrate future: read live via daemon/API and stitch in the reader with a
  last-successful cache. Do not materialize substrate-native state into another
  SQLite projection.

## Test Plan

- Contract fixture tests for every signal type.
- Schema validation tests for dashboard specs and panel inserts.
- Safety tests for bounded ranges/results and forbidden labels.
- Approval-state tests for agent-authored dashboard writes.
- Regression tests proving existing Console Bead Inspector and Operations routes
  still render after observability shell additions.
- Build/typecheck gates for `apps/console`; `apps/gitboard` remains reference
  until Console is the deployed service.
