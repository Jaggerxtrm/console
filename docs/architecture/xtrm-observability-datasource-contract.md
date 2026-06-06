# xtrm Observability Datasource Contract

Status: design contract for `forge-ow7c.3`, pre-implementation.

Console consumes telemetry; it does not own telemetry production. This contract
defines the boundary between Console panels/evidence surfaces and upstream
systems such as Prometheus, Grafana, Loki, specialists forensic state, future
OpenTelemetry traces, AWS/CloudWatch evidence, and substrate-native records.

## Ownership

- `mercury/infra` owns Prometheus, Grafana, Loki, Alertmanager, exporters,
  scrape targets, alert rules, Terraform/IaC, and future infra query MCP.
- `specialists` owns AgentOps runtime events, `xtrm.forensic.v1`, Prometheus
  projections, MCP/tool semantics, token usage, evals, and policy/identity
  evidence.
- Console owns datasource descriptors, query proxy/client contracts, dashboard
  JSON, panel rendering, drilldowns, and operator approval UX.

If a signal is missing, Console records a missing-signal evidence item and routes
work to the owning repo. It must not patch local fake metrics into existence.

## Query And Evidence Flow

```mermaid
flowchart LR
    Panel["Console panel\nStat, TimeSeries, Threshold, Evidence list"]
    Request["ObserveQueryRequest\nsignal, query, range, limits, tenant"]
    Datasource["ObserveDatasource\nPrometheus, Grafana, Loki,\nForensic, Substrate, Fixture"]
    Response["ObserveQueryResponse\nstatus, freshness, data"]
    Evidence["ObserveEvidenceRef\nquery, correlation, redaction, links"]
    Drawer["Evidence drawer\ncopy query, inspect ids, open upstream"]
    Followup["Missing-signal follow-up\nowning repo"]

    Panel --> Request
    Request --> Datasource
    Datasource --> Response
    Response --> Panel
    Response --> Evidence
    Evidence --> Drawer
    Response -. "status=missing_signal" .-> Followup
```

Panels are deliberately not tied to Prometheus result types. Every response
carries freshness and evidence metadata so aggregate symptoms can drill down to
forensic rows, Grafana panels, traces, jobs, beads, runbooks, or GitHub objects.

## Signals

The datasource layer is multi-signal from day one.

```ts
export type ObserveSignalKind =
  | "metric"
  | "log"
  | "trace"
  | "eval"
  | "alert"
  | "dashboard"
  | "journal"
  | "recommendation"
  | "runbook"
  | "forensic_event";
```

Phase 0 may render only metrics and evidence metadata, but the contract must
already carry all signal kinds so dashboards and agent-authored panels do not
become Prometheus-only.

## Datasource Descriptor

```ts
export interface ObserveTenantContext {
  tenantId: string;
  deploymentEnvironment: "local" | "staging" | "production" | string;
  repo?: string;
  serviceNamespace?: string;
  serviceName?: string;
}

export interface ObserveDatasourceDescriptor {
  id: string;
  kind:
    | "prometheus"
    | "grafana"
    | "loki"
    | "otel_trace"
    | "specialists_forensic"
    | "aws_agentcore"
    | "substrate"
    | "static_fixture";
  title: string;
  tenant: ObserveTenantContext;
  authMode: "server_proxy" | "internal_socket" | "none";
  capabilities: ObserveSignalKind[];
  writePolicy: "read_only" | "draft_requires_approval";
  freshness: ObserveFreshness;
  links?: ObserveLink[];
}
```

Rules:

- `authMode="server_proxy"` is the default for networked backends. Browser code
  never receives raw Prometheus/Grafana/AWS credentials.
- `writePolicy="read_only"` is required for query backends. Agent-authored
  dashboard specs are drafts until the operator accepts them.
- `substrate` means future live substrate daemon/API reads. Do not copy
  substrate-native state into a second SQLite projection.
- `static_fixture` exists for tests, previews, and design fixtures.

## Query Request

```ts
export interface ObserveQueryRequest {
  datasourceId: string;
  signalKind: ObserveSignalKind;
  query: ObserveQuery;
  range: ObserveTimeRange;
  tenant: ObserveTenantContext;
  limits: ObserveQueryLimits;
  evidenceContext?: ObserveEvidenceContext;
}

export type ObserveQuery =
  | { kind: "promql"; expr: string }
  | { kind: "logql"; expr: string }
  | { kind: "grafana_panel"; dashboardUid: string; panelId: string; vars?: Record<string, string | string[]> }
  | { kind: "trace_lookup"; traceId: string; spanId?: string }
  | { kind: "forensic_events"; jobId?: string; beadId?: string; cursor?: string }
  | { kind: "eval_lookup"; evalId?: string; jobId?: string }
  | { kind: "recommendation_lookup"; recommendationId?: string; taskId?: string }
  | { kind: "journal_lookup"; taskId?: string; cursor?: string }
  | { kind: "runbook_lookup"; ref: string };

export interface ObserveTimeRange {
  fromUnixMs: number;
  toUnixMs: number;
  stepMs?: number;
}

export interface ObserveQueryLimits {
  maxSeries?: number;
  maxRows?: number;
  maxBytes?: number;
  timeoutMs?: number;
}
```

Rules:

- Every request has an explicit time range except direct id lookups.
- Query limits are mandatory at the server boundary.
- Raw shell commands, raw URLs as query language, and arbitrary file paths are
  not datasource queries.
- PromQL/LogQL strings pass through to owning backends; Console does not parse
  or reinterpret their language beyond validation/syntax highlighting.

## Query Response

```ts
export interface ObserveQueryResponse {
  datasourceId: string;
  signalKind: ObserveSignalKind;
  status: "ok" | "partial" | "missing_signal" | "error";
  range: ObserveTimeRange;
  freshness: ObserveFreshness;
  data: ObserveResultData;
  evidence: ObserveEvidenceRef[];
  diagnostics?: ObserveDiagnostics;
}

export type ObserveResultData =
  | { kind: "metric_matrix"; series: ObserveMetricSeries[] }
  | { kind: "metric_vector"; samples: ObserveMetricSample[] }
  | { kind: "logs"; rows: ObserveLogRow[] }
  | { kind: "trace"; trace: ObserveTraceSummary }
  | { kind: "eval"; evals: ObserveEvalSummary[] }
  | { kind: "alerts"; alerts: ObserveAlertSummary[] }
  | { kind: "dashboard_ref"; dashboard: ObserveDashboardRef }
  | { kind: "journal"; records: ObserveJournalRecord[] }
  | { kind: "recommendations"; records: ObserveRecommendationRecord[] }
  | { kind: "forensic_events"; events: unknown[] };
```

`partial` is valid when one backend returns enough evidence to render a useful
panel but some linked drilldown is unavailable. `missing_signal` means Console
knows which owning repo must add a signal.

## Evidence References

Evidence refs are the drilldown bridge from aggregate panel to precise detail.

```ts
export interface ObserveEvidenceRef {
  id: string;
  kind:
    | "prometheus_query"
    | "grafana_dashboard"
    | "grafana_panel"
    | "loki_query"
    | "trace_span"
    | "specialist_forensic_event"
    | "specialist_job"
    | "eval_result"
    | "alert"
    | "journal_record"
    | "recommendation"
    | "runbook"
    | "bead"
    | "github";
  source: string;
  title: string;
  timeRange?: ObserveTimeRange;
  queryText?: string;
  correlation?: Record<string, string>;
  redaction?: { status: "clean" | "redacted" | "unknown"; fields?: string[] };
  links?: ObserveLink[];
}
```

High-cardinality identifiers such as `job_id`, `bead_id`, `trace_id`,
`span_id`, `tool_call_id`, `mcp_session_id`, `jsonrpc_request_id`,
`recommendationId`, and `journalRecordId` belong in `correlation` and evidence
refs. They must not become Prometheus labels.

## Label Discipline

Console must treat the specialists Prometheus projection contract as
authoritative for labels.

Allowed labels include bounded identity and state fields such as:

- `service_namespace`
- `service_name`
- `service_component`
- `deployment_environment`
- `repo`
- `participant_kind`
- `participant_role`
- `state`
- `result`
- `model_provider`
- allowlisted `model`
- normalized `tool_name`
- `mcp_server`
- `mcp_method`
- normalized `error_type`
- `direction`
- `policy_kind`
- `eval_kind`
- `chain_template`
- `gate_kind`

Forbidden labels include:

- `job_id`
- `bead_id`
- `issue_id`
- `participant_id`
- `chain_id`
- `container_id`
- `trace_id`
- `span_id`
- `session_id`
- `conversation_id`
- `tool_call_id`
- `mcp_session_id`
- `jsonrpc_request_id`
- `eval_id`
- `policy_decision_id`
- raw path, command, URL, error text, prompt, diff, user/email/token, or secret
  material.

## Freshness And Cache

```ts
export interface ObserveFreshness {
  observedAtUnixMs?: number;
  sourceUpdatedAtUnixMs?: number;
  cachedAtUnixMs?: number;
  cacheStatus: "live" | "last_successful" | "stale" | "fixture" | "unknown";
  maxAgeMs?: number;
}
```

Rules:

- Panels must show when they are using `last_successful` or `stale` data.
- Substrate-native reads may use a small last-successful cache to survive daemon
  restarts. That cache is not a materializer.
- Fixture responses must remain visibly marked as `fixture`.

## Safety And Auth

- Networked datasource requests go through a server-side proxy.
- Grafana/MCP posture is read-only by default, equivalent to disable-write plus
  tool/category allowlists.
- Agent-authored dashboard/panel specs are drafts until accepted by an operator.
- Writes to Grafana dashboards, alert rules, incidents, or annotations are out
  of scope for Console Phase 0/1.
- Request/response payload visibility is opt-in, redacted, and trace-linked.
- Missing upstream data becomes follow-up work in the owning repo, not a local
  workaround.

## Fixture Requirements

The first fixture pack should include:

- Prometheus metric matrix and vector rows.
- Grafana dashboard/panel/deeplink evidence refs.
- Loki/log evidence rows with labels.
- OTel trace/span summary with linked MCP tool call.
- Specialists `xtrm.forensic.v1` event envelope.
- Eval result summary.
- AWS-style task/recommendation/journal records.
- Missing-signal example routed to `mercury/infra`.
- Forbidden-label rejection fixture.

## Follow-Up Beads

Created under `forge-ow7c` and blocked on this contract where appropriate:

- `forge-ow7c.8`: implement Console datasource contract and static fixture
  datasource.
- `forge-ow7c.9`: add contract fixtures and safety guards for every
  `ObserveSignalKind`, range, result limits, auth mode, forbidden labels, and
  missing-signal routing.
- `forge-ow7c.10`: define dashboard schema validator, migration fixture, and
  agent-authored approval-state tests.
- `forge-ow7c.11`: implement first Phase 0 panels against static fixtures, not
  live Prometheus.
