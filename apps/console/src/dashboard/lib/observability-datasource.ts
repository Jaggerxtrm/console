import type {
  ObserveDatasourceDescriptor,
  ObserveEvidenceRef,
  ObserveQueryRequest,
  ObserveQueryResponse,
  ObserveSignalKind,
  ObserveTenantContext,
  ObserveTimeRange,
} from "../../types/observability.ts";

const FIXTURE_NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

export const observeFixtureTenant: ObserveTenantContext = {
  tenantId: "self",
  deploymentEnvironment: "local",
  repo: "gitboard",
  serviceNamespace: "xtrm",
  serviceName: "console",
};

export const observeFixtureRange: ObserveTimeRange = {
  fromUnixMs: FIXTURE_NOW - 60 * 60 * 1000,
  toUnixMs: FIXTURE_NOW,
  stepMs: 60_000,
};

export const observeStaticFixtureDatasource: ObserveDatasourceDescriptor = {
  id: "self-static-fixture",
  kind: "static_fixture",
  title: "Static Console Observability Fixture",
  tenant: observeFixtureTenant,
  authMode: "none",
  capabilities: [
    "metric",
    "log",
    "trace",
    "eval",
    "alert",
    "dashboard",
    "journal",
    "recommendation",
    "runbook",
    "forensic_event",
  ],
  writePolicy: "read_only",
  freshness: {
    observedAtUnixMs: FIXTURE_NOW,
    sourceUpdatedAtUnixMs: FIXTURE_NOW,
    cachedAtUnixMs: FIXTURE_NOW,
    cacheStatus: "fixture",
    maxAgeMs: 0,
  },
  links: [{ label: "Datasource contract", href: "/docs/architecture/xtrm-observability-datasource-contract.md", kind: "docs" }],
};

export function createObserveFixtureRequest(signalKind: ObserveSignalKind): ObserveQueryRequest {
  return {
    datasourceId: observeStaticFixtureDatasource.id,
    signalKind,
    query: defaultQueryForSignal(signalKind),
    range: observeFixtureRange,
    tenant: observeFixtureTenant,
    limits: { maxSeries: 12, maxRows: 50, maxBytes: 64_000, timeoutMs: 2_000 },
  };
}

export function queryStaticObserveDatasource(request: ObserveQueryRequest): ObserveQueryResponse {
  const evidence = evidenceFor(request);
  const base = {
    datasourceId: request.datasourceId,
    signalKind: request.signalKind,
    range: request.range,
    freshness: observeStaticFixtureDatasource.freshness,
    evidence,
  };

  switch (request.signalKind) {
    case "metric":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "metric_matrix",
          series: [
            {
              metric: { repo: "gitboard", participant_role: "executor", state: "running" },
              samples: [
                { metric: { state: "running" }, value: 2, tUnixMs: request.range.fromUnixMs },
                { metric: { state: "running" }, value: 3, tUnixMs: request.range.toUnixMs },
              ],
            },
          ],
        },
      };
    case "log":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "logs",
          rows: [
            {
              tUnixMs: request.range.toUnixMs - 30_000,
              labels: { service: "gitboard", stack: "local", container: "console" },
              message: "source_health.changed healthy=true source=dolt",
            },
          ],
        },
      };
    case "trace":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "trace",
          trace: {
            traceId: "trace-fixture-001",
            rootName: "invoke_agent executor",
            spans: [
              { spanId: "span-root", name: "invoke_agent executor", durationMs: 820 },
              { spanId: "span-tool", parentSpanId: "span-root", name: "tools/call get_targets", durationMs: 120 },
            ],
          },
        },
      };
    case "eval":
      return {
        ...base,
        status: "ok",
        data: { kind: "eval", evals: [{ evalId: "eval-fixture-001", evalKind: "gate", result: "pass", score: 0.98 }] },
      };
    case "alert":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "alerts",
          alerts: [
            {
              alertName: "SpecialistQueueDepthHigh",
              state: "firing",
              severity: "warning",
              labels: { repo: "gitboard", participant_role: "executor" },
            },
          ],
        },
      };
    case "dashboard":
      return {
        ...base,
        status: "ok",
        data: { kind: "dashboard_ref", dashboard: { dashboardUid: "agentops-runtime", title: "Specialist Runtime" } },
      };
    case "journal":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "journal",
          records: [{ journalRecordId: "journal-fixture-001", taskId: "task-fixture-001", title: "Queue investigation", tUnixMs: request.range.toUnixMs }],
        },
      };
    case "recommendation":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "recommendations",
          records: [{ recommendationId: "rec-fixture-001", taskId: "task-fixture-001", title: "Add queue drain dashboard", status: "proposed", priority: "medium" }],
        },
      };
    case "runbook":
      return {
        ...base,
        status: "ok",
        data: { kind: "runbook", ref: "docs/AGENT_MONITORING.md", title: "Agent Monitoring Reference", body: "Read health file, inspect alert log, confirm live state." },
      };
    case "forensic_event":
      return {
        ...base,
        status: "ok",
        data: {
          kind: "forensic_events",
          events: [
            {
              schema_version: "xtrm.forensic.v1",
              t_unix_ms: request.range.toUnixMs,
              seq: 1,
              severity: "info",
              event_family: "job",
              event_name: "job.completed",
              resource: { service_namespace: "xtrm", service_name: "specialists", participant_role: "executor" },
              correlation: { job_id: "job-fixture-001", bead_id: "forge-fixture" },
              body: { result: "success" },
              redaction: { status: "clean" },
            },
          ],
        },
      };
  }
}

function defaultQueryForSignal(signalKind: ObserveSignalKind): ObserveQueryRequest["query"] {
  switch (signalKind) {
    case "metric":
      return { kind: "promql", expr: "sum by (repo, participant_role, state) (xtrm_job_state)" };
    case "log":
      return { kind: "logql", expr: "{service=\"gitboard\"} |= \"source_health\"" };
    case "trace":
      return { kind: "trace_lookup", traceId: "trace-fixture-001" };
    case "eval":
      return { kind: "eval_lookup", evalId: "eval-fixture-001" };
    case "alert":
    case "dashboard":
      return { kind: "grafana_panel", dashboardUid: "agentops-runtime", panelId: "queue-depth" };
    case "journal":
      return { kind: "journal_lookup", taskId: "task-fixture-001" };
    case "recommendation":
      return { kind: "recommendation_lookup", recommendationId: "rec-fixture-001" };
    case "runbook":
      return { kind: "runbook_lookup", ref: "docs/AGENT_MONITORING.md" };
    case "forensic_event":
      return { kind: "forensic_events", jobId: "job-fixture-001" };
  }
}

function evidenceFor(request: ObserveQueryRequest): ObserveEvidenceRef[] {
  const queryText = "expr" in request.query ? request.query.expr : JSON.stringify(request.query);
  return [
    {
      id: `${request.signalKind}-fixture-evidence`,
      kind: evidenceKindForSignal(request.signalKind),
      source: observeStaticFixtureDatasource.id,
      title: `${request.signalKind} fixture evidence`,
      timeRange: request.range,
      queryText,
      correlation: { job_id: "job-fixture-001", trace_id: "trace-fixture-001" },
      redaction: { status: "clean" },
      links: observeStaticFixtureDatasource.links,
    },
  ];
}

function evidenceKindForSignal(signalKind: ObserveSignalKind): ObserveEvidenceRef["kind"] {
  switch (signalKind) {
    case "metric":
      return "prometheus_query";
    case "log":
      return "loki_query";
    case "trace":
      return "trace_span";
    case "eval":
      return "eval_result";
    case "alert":
      return "alert";
    case "dashboard":
      return "grafana_dashboard";
    case "journal":
      return "journal_record";
    case "recommendation":
      return "recommendation";
    case "runbook":
      return "runbook";
    case "forensic_event":
      return "specialist_forensic_event";
  }
}
