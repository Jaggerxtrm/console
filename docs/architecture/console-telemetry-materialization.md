# Console Telemetry Materialization

Status: implementation bridge, pre-Substrate.

This document is the local source of truth for Gitboard/Console telemetry
materialization while xtrm migrates from Beads plus Specialists plus GitHub into
native Substrate.

Operational ownership boundaries between UI, APIs, materializer, GitHub, and
future Substrate are defined in
`docs/architecture/console-app-materializer-api-boundaries.md`.

Authoritative upstream contracts:

- `/home/dawid/dev/specialists/docs/telemetry/forensic-event-contract.md`
- `/home/dawid/dev/specialists/docs/telemetry/agentops-event-catalog.md`
- `/home/dawid/dev/specialists/docs/telemetry/prometheus-projection-contract.md`
- `/home/dawid/dev/specialists/docs/telemetry/prometheus-infra-console-handoff.md`
- `/home/dawid/dev/specialists/docs/design/roadmap/specialists-roadmap.md`
- `/home/dawid/second-mind/1-projects/xtrm/substrate/substrate_design_it.md`

## System Map

```mermaid
flowchart LR
    subgraph Sources["Upstream Sources"]
        Beads["Beads graph\nissues, deps, memories"]
        Specialists["Specialists observability\nforensic events, job metrics"]
        GitHub["GitHub\nPRs, issues, commits, releases"]
        Infra["Prometheus/Grafana/Loki\nlow-cardinality projections"]
        FutureSubstrate["Future Substrate daemon/API\nnative state.db"]
    end

    Materializer["Gitboard materializer\nbridge read-model writer"]
    State["xtrm.sqlite / state.db bridge\nsubstrate_*, specialist_*, xtrm_* tables"]
    API["Console APIs\n/api/substrate, /api/specialists, /api/feed"]
    Console["Console UI\nread surface + drilldowns"]

    Beads --> Materializer
    Specialists --> Materializer
    GitHub --> Materializer
    Materializer --> State
    State --> API
    API --> Console
    Infra -. "read/query/deeplink" .-> Console
    FutureSubstrate -. "future live read + last-successful cache" .-> API
```

The important split is that the materializer writes only bridge state. Console
reads APIs; Prometheus/Grafana remain aggregate/deeplink sources; future
Substrate should be read live rather than copied into another SQLite projection.

## Positioning

Console is a read surface. It should render state, evidence, metrics and
forensic drill-downs, but it must not become the owner of issue execution,
specialist execution, or telemetry semantics.

The current materializer is a migration bridge:

- Beads issue/dependency materialization is temporary, but pre-Substrate
  Specialists will rely on more of the Beads graph than Console currently uses.
  These bridge patches should survive until the later Beads to Substrate
  migration, not merely until the first Substrate daemon lands.
- Specialists observability materialization is temporary until Substrate and
  Specialists share the unified runtime state.
- GitHub materialization is different: GitHub is remote, rate-limited, and
  external, so a local adapter/materializer remains the likely durable shape.
- Native Substrate should be read through its daemon/API and native cursor or
  stream. Console should keep a last-successful cache, not copy Substrate into a
  second SQLite projection.

The app may still be named Gitboard in code during this tranche. The product
target is Console, but visual design, route rename, package rename, and broad
Gitboard string removal are explicitly outside this bridge work.

## Bridge State

The local `state.db`/`xtrm.sqlite` bridge stores a disposable read model.
Tables named `substrate_*` in this repo are bridge/projection tables, not the
future Substrate engine schema. Do not infer future Substrate ownership from
those names.

Canonical telemetry rows use generic xtrm tables:

- `xtrm_forensic_events` stores `xtrm.forensic.v1` envelopes from any emitter.
- `xtrm_evidence_refs` stores evidence references such as diff, commit, PR,
  verdict, test, report, RCA and dashboard.
- `specialist_jobs` carries current specialist run state plus materialized job
  metrics needed by Console: turns, tools, model and token split.

High-cardinality identifiers remain in `correlation_json`, `body_json`,
`links_json`, `trace_json` or evidence refs. They are never Prometheus labels.

## Beads Runtime Graph Bridge

Before Substrate absorbs runtime state, Beads is the Specialists orchestration
graph. Console must therefore materialize enough of Beads to show the real
runtime shape, not only a flat list of issues and dependency chips.

The bridge must preserve:

- hierarchy: organizational epic to chain molecule to root issue to step beads;
- issue class and role signals such as `issue_type=molecule`, `kind:step`,
  gate/reviewer/advisor labels, and formula/template provenance;
- all typed relationships used by the Specialists roadmap, including blocking,
  parent-child, validates, discovered-from, related and supersedes edges;
- raw labels, metadata and descriptions needed to reconstruct molecule and
  step semantics;
- contract text embedded in descriptions, including `<change-contract>` and
  `<step-contract>` XML blocks;
- Beads memory references and recall context when they become part of a visible
  chain or specialist run.

Do not collapse this graph into a generic dependency list. A typed edge is a
semantic runtime fact, and Console drill-downs should be able to answer whether
a bead is an organizational epic, a chain molecule, a root change bead, a
review gate, a test step or a discovered follow-up.

`sp epic` and chain views should be treated as decorated readers over the Beads
children/dependency graph plus Specialists observability joins. Console should
not model a separate epic state machine. This matches the pre-Substrate roadmap
and keeps the migration path clean: the same hierarchy and edge vocabulary can
move from Beads rows to Substrate state rows later.

The current `substrate_*` bridge tables are allowed to project this Beads graph
for Console, but they must remain conceptually legacy projections. They should
not become an alternate Substrate schema.

## Materializer Contract

Every source adapter must be additive and idempotent:

- write state and cursor in one transaction;
- emit WebSocket hints only after commit;
- preserve last successful state on source failure;
- record failures and fallbacks as forensic `materializer.*` events;
- keep source-specific high-cardinality fields out of metric labels.

Specialists observability uses this priority order:

1. Read `specialist_forensic_events` when available and preserve the full
   envelope.
2. Read `specialist_job_metrics` for model, turns, tools and token split.
3. Fall back to legacy `specialist_events` only when the forensic table is
   absent, wrapping legacy JSON in an `xtrm.forensic.v1`-compatible envelope.

GitHub and Beads/Substrate bridge emitters should reuse the same forensic
contract instead of creating Gitboard-specific event names when a catalog event
already exists.

### Materializer Run Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Scheduler as Scanner / watcher / timer
    participant Mat as Materializer
    participant Adapter as Source adapter
    participant Source as Source DB/API/files
    participant State as xtrm.sqlite
    participant WS as ChannelRegistry
    participant API as Console API
    participant UI as Console UI

    Scheduler->>Mat: request run(source_key, cursor)
    Mat->>State: mark materialization_state running
    Mat->>Adapter: read since cursor
    Adapter->>Source: fetch source rows/events
    Source-->>Adapter: rows + next cursor
    Adapter-->>Mat: normalized rows, deps, forensic/evidence refs
    Mat->>State: transaction write rows + cursor
    State-->>Mat: commit ok
    Mat->>WS: publish sync hint after commit
    UI->>API: refresh/read DTOs
    API->>State: read materialized state only
    State-->>API: DTO source rows
    API-->>UI: display rows + drilldown pointers

    alt source failure
        Adapter-->>Mat: error/fallback
        Mat->>State: preserve last success + record failure event
        Mat->>WS: publish degraded/freshness hint
    end
```

Run ordering matters: cursors advance only inside the same transaction as row
writes, and websocket hints are emitted only after commit. This is what keeps
the UI from rendering a future cursor with stale or half-written rows.

## API And UI Boundary

`/api/specialists/jobs/:job_id/feed-events` serves ordered forensic envelopes
from local state by `(t_unix_ms, seq)`. The response is canonical-envelope-first:
Console may project small display rows, but the API must preserve body,
correlation, redaction, trace and links that have already been redacted upstream.

`/api/feed` is intentionally a later layer. Its contract is a cursor-paginated
rollup over materialized specialists forensic rows, Beads/Substrate issue
events, and GitHub events. It must not be a raw forensic firehose.

Feed rows are ordered by `(t_unix_ms, seq)` and carry display-ready rollup
fields plus drilldown pointers back to state rows:

- `source`: `specialists`, `beads`, `github` or `materializer`;
- `kind`: source-specific rollup kind such as `job_completed`,
  `issue_updated`, `pull_request` or `malformed_source_row`;
- `repo_slug`, `title`, `summary`, `severity`, `status`,
  `redaction_status`;
- `drilldown`: pointers such as `job_id`, `issue_id`, `github_event_id`,
  `forensic_event_ids` and `evidence_ids`.

The route must read materialized state only. It must tolerate malformed source
rows by emitting a redacted `materializer/malformed_source_row` rollup instead
of breaking the page. It must not include full forensic `body`, `correlation`,
`trace`, `links` or `envelope` blobs in feed rows; detailed drilldown fetches
those from forensic/evidence state.

Executable contract fixture:
`apps/gitboard/tests/fixtures/api-feed-rollup-contract.json`, validated by
`apps/gitboard/tests/api/feed-rollup-contract.test.ts`.

The UI may render compact forensic summaries now, but detailed visual Console
design is owned by the separate Console design work.

## Prometheus Boundary

Prometheus is a projection, not truth. Operations panels should use only
low-cardinality metrics from the upstream projection contract, including:

- `xtrm_jobs_total`
- `xtrm_job_duration_seconds`
- `xtrm_job_wait_seconds`
- `xtrm_job_state`
- `xtrm_llm_tokens_total`
- `xtrm_chains_total`
- `xtrm_chain_duration_seconds`
- `xtrm_gate_verdicts_total`
- `xtrm_evidence_refs_total`

Forbidden labels include `job_id`, `bead_id`, `issue_id`, `chain_id`,
`participant_id`, `trace_id`, `span_id`, `tool_call_id`, raw path, raw command,
raw URL, raw error text, raw diff, prompt text, user/email, token and credential
material.

Drill-down from a metric symptom into a concrete run, issue, file, diff or PR
goes through forensic/evidence state, not through Prometheus label cardinality.

Executable guardrail: `apps/gitboard/tests/fixtures/operations-prometheus-metrics.json`
is validated by
`apps/gitboard/tests/server/observability/prometheus-cardinality.test.ts`.
