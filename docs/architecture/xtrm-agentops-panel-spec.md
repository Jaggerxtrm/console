# xtrm AgentOps Panel Spec

Status: planning output for `forge-ow7c.4`, pre-implementation.

This spec defines Console Operations panels for specialists/AgentOps telemetry.
It consumes the upstream specialists contracts:

- `/home/dawid/dev/specialists/docs/telemetry/forensic-event-contract.md`
- `/home/dawid/dev/specialists/docs/telemetry/prometheus-projection-contract.md`
- `/home/dawid/dev/specialists/docs/telemetry/agentops-event-catalog.md`
- `/home/dawid/dev/specialists/docs/observability-metrics.md`

Console must not duplicate metric definitions. Every panel below either names an
upstream `xtrm_*` metric or explicitly marks the signal as future/missing.

## Panel Data Map

```mermaid
flowchart LR
    Metrics["Prometheus projection\nxtrm_* low-cardinality metrics"]
    Forensic["xtrm.forensic.v1 events\nrich correlation + redaction"]
    Jobs["specialist_job_metrics\nturns, tools, token split"]
    Panels["Console AgentOps panels\nruntime, tokens, tools, MCP, evidence"]
    Evidence["Evidence drawer\njob, trace, bead, PR, runbook"]

    Metrics --> Panels
    Jobs --> Panels
    Forensic --> Evidence
    Panels --> Evidence

    Metrics -. "symptom aggregate" .-> Panels
    Evidence -. "precise drilldown" .-> Forensic
```

The panels start from aggregate metrics or job metric rows, then drill down into
forensic/evidence state for exact IDs and payloads. This prevents dashboards
from grouping by high-cardinality runtime identifiers.

## Panel Groups

### 1. Runtime State

Purpose: answer whether specialist work is flowing or stuck.

Panels:

- Active jobs by state:
  - query: `sum by (repo, participant_role, state) (xtrm_job_state)`
  - render: stacked stat/table
  - drilldown: specialist job list filtered by bounded labels and time range
- Queue depth:
  - query: `sum by (repo, participant_role) (xtrm_job_queue_depth)`
  - render: stat plus threshold
  - alert candidate: queue above policy for N minutes
- Wait duration:
  - query: histogram quantile over `xtrm_job_wait_seconds_bucket`
  - render: time series p50/p95/p99
  - drilldown: forensic events for waiting/resumed jobs
- Job duration:
  - query: histogram quantile over `xtrm_job_duration_seconds_bucket`
  - render: time series and distribution
  - drilldown: result/evidence refs for slow terminal jobs

Acceptance:

- No panel labels by `job_id`, `bead_id`, `chain_id`, `participant_id`, or raw
  path.
- Missing wait histogram renders `missing_signal` with owner `specialists`.

### 2. Turns, Context, And Tokens

Purpose: show model pressure and budget proxies without pretending USD is
authoritative.

Panels:

- Turns completed:
  - query: `sum by (repo, participant_role, result) (rate(xtrm_turns_total[5m]))`
  - render: rate time series
- Context usage:
  - query: `max by (repo, participant_role) (xtrm_context_usage_ratio)`
  - render: threshold table
- Token split:
  - query: `sum by (repo, participant_role, model_provider, model, direction) (rate(xtrm_llm_tokens_total{direction!="total"}[5m]))`
  - render: stacked time series by direction
- Token fallback:
  - query: `sum by (repo, participant_role, model_provider, model) (rate(xtrm_llm_tokens_total{direction="total"}[5m]))`
  - render: separate fallback-only stat

Rules:

- Never add split directions and `direction="total"` in the same total.
- USD is not displayed as a metric unless backed by direct billing or versioned
  pricing provenance. Until then, panel copy says token usage, not cost.
- `model` is allowed only through upstream allowlist/normalization.

### 3. Tool Calls

Purpose: make tool latency/failure visible without exposing raw commands,
arguments, or file paths.

Panels:

- Tool call rate:
  - query: `sum by (repo, participant_role, tool_name, result) (rate(xtrm_tool_calls_total[5m]))`
  - render: table sorted by error rate
- Tool duration:
  - query: histogram quantile over `xtrm_tool_call_duration_seconds_bucket`
  - render: p95 time series by normalized `tool_name`
- Tool errors:
  - query: `sum by (repo, participant_role, tool_name, error_type) (rate(xtrm_tool_errors_total[5m]))`
  - render: threshold table

Drilldown:

- evidence kind `specialist_forensic_event`
- correlation may include `tool_call_id`, but only inside evidence metadata
- body/result payloads stay redacted unless the upstream event says clean

### 4. MCP Operations

Purpose: prepare the Console for real MCP telemetry while being honest about
current bridge status.

Panels:

- MCP operations:
  - query: `sum by (repo, mcp_server, mcp_method, result) (rate(xtrm_mcp_operations_total[5m]))`
  - status: shipped for supplied forensic events
- MCP operation duration:
  - query: histogram quantile over `xtrm_mcp_operation_duration_seconds_bucket`
  - status: future until real MCP lifecycle durations exist
- MCP sessions:
  - query: `sum by (repo, mcp_server, state) (xtrm_mcp_sessions)`
  - status: future until session emitter exists
- MCP session duration:
  - query: histogram quantile over `xtrm_mcp_session_duration_seconds_bucket`
  - status: future until session emitter exists

Rules:

- Show future panels as missing-signal contracts, not empty charts.
- Never label by `mcp_session_id`, `jsonrpc_request_id`, `trace_id`,
  `tool_call_id`, raw args, result text, URL, or token.

### 5. Result And Evidence

Purpose: connect runtime aggregates to durable proof.

Panels:

- Results persisted:
  - query: `sum by (repo, participant_role, target, result) (rate(xtrm_results_persisted_total[5m]))`
  - render: table
- Evidence refs:
  - query: `sum by (repo, evidence_kind, result) (rate(xtrm_evidence_refs_total[5m]))`
  - render: stat/table
- Gate verdicts:
  - query: `sum by (repo, participant_role, gate_kind, verdict) (rate(xtrm_gate_verdicts_total[5m]))`
  - render: stacked stat and recent verdict list

Drilldown:

- evidence refs open Bead Inspector, chain detail, GitHub PR/commit, report, or
  forensic event depending on `evidence_kind`.

### 6. Worktree And Process Health

Purpose: surface operational debt that breaks specialist throughput.

Panels:

- Worktrees by state:
  - query: `sum by (repo, state) (xtrm_worktrees)`
  - render: stat/table
- Worktree age:
  - query: `max by (repo, state) (xtrm_worktree_age_seconds)`
  - render: threshold table
- Processes by kind/state:
  - query: `sum by (repo, process_kind, state) (xtrm_processes)`
  - render: stat/table
- Orphan process detections:
  - query: `sum by (repo, process_kind, result) (rate(xtrm_process_orphans_total[15m]))`
  - render: time series
- Process restarts:
  - query: `sum by (repo, process_kind, reason) (rate(xtrm_process_restarts_total[15m]))`
  - render: table

Rules:

- `process_kind` is bounded: `specialist`, `dolt`, `gitnexus`, `lsp`, `pi`, or
  upstream-defined equivalent.
- Worktree paths are never labels.

### 7. Eval, Identity, Policy

Purpose: make quality and governance visible when upstream emits it.

Panels:

- Eval runs:
  - query: `sum by (repo, eval_kind, result) (rate(xtrm_eval_runs_total[15m]))`
  - status: future/partial until eval emitters are live
- Eval score:
  - query: `max by (repo, eval_kind) (xtrm_eval_score)`
  - status: future/partial
- Identity operations:
  - query: `sum by (repo, credential_kind, result) (rate(xtrm_identity_operations_total[15m]))`
  - status: supplied-forensic-events
- Policy decisions:
  - query: `sum by (repo, policy_kind, action_kind, result) (rate(xtrm_policy_decisions_total[15m]))`
  - status: supplied-forensic-events
- Policy mismatches:
  - query: `sum by (repo, policy_kind, severity) (rate(xtrm_policy_mismatches_total[15m]))`
  - status: supplied-forensic-events

Rules:

- Identity/policy panels are audit signals, not an authorization source of truth.
- Secret values, request payloads, and provider error bodies never render unless
  upstream redaction marks them clean and the operator explicitly opens detail.

## Dashboard Packs

Initial internal packs:

1. Specialist Runtime
   - Runtime State
   - Turns/Context/Tokens
   - Tool Calls
   - Results/Evidence

2. AgentOps Governance
   - Gate Verdicts
   - Eval
   - Identity/Policy
   - Evidence refs

3. Specialist Infrastructure
   - Worktree/process health
   - MCP Operations
   - Queue/Wait

Every pack must expose:

- datasource id
- time range
- query text
- evidence refs
- freshness/cache status
- missing-signal owner

## Acceptance Checklist

- Panels consume upstream `xtrm_*` metric names.
- Panels mark missing future signals instead of silently showing empty charts.
- No panel query uses forbidden labels.
- Token totals do not mix split directions with `direction="total"`.
- USD is deferred/non-authoritative.
- Drilldowns use `ObserveEvidenceRef` from the datasource contract.
- Existing Console Operations and Bead Inspector routes remain regression-tested
  when these panels are later implemented.
