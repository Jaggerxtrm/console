export type TimeRange = "7d" | "30d" | "all";

type TokenTotals = { input: number; output: number; cacheCreation: number; cacheRead: number; total: number };
type TokenGroup = TokenTotals & { specialist: string };
type ModelTokenGroup = TokenTotals & { model: string };
type HitRateGroup = { specialist: string; hitRate: number };
type ModelHitRateGroup = { model: string; hitRate: number };
type AverageRow = { specialist: string; avgTokens: number; avgElapsedMs: number; avgTurns: number; avgTools: number };
type RuntimeGroup = { specialist: string; ms: number };
type ModelRuntimeGroup = { model: string; ms: number };
type ReliabilityRow = { specialist: string; done: number; error: number; cancelled: number; staleWarnings: number };
type SlowJob = { jobId: string; specialist: string; beadId: string; model: string; elapsedMs: number; turns: number; tools: number };
type ToolCount = { tool: string; count: number };
type ToolCrossTab = { specialist: string; tools: ToolCount[] };
type OutcomeCounts = { pass: number; partial: number; fail: number; unknown: number };
type ContextBurnRow = { specialist: string; avgFinalContextPct: number };
type StallGroup = { specialist: string; totalMs: number; staleWarnings: number };
type LongestStall = { jobId: string; specialist: string; totalMs: number };
type ChainBucket = { bucket: "1" | "2" | "3-5" | "6-10" | "10+"; count: number };
type EpicCount = { status: string; count: number };

export interface ObservabilitySummary {
  range: TimeRange;
  tokens: {
    totals: TokenTotals;
    bySpecialist: TokenGroup[];
    byModel: ModelTokenGroup[];
  };
  cacheHitRate: { bySpecialist: HitRateGroup[]; byModel: ModelHitRateGroup[] };
  averages: AverageRow[];
  activeRuntime: { bySpecialist: RuntimeGroup[]; byModel: ModelRuntimeGroup[] };
  reliability: ReliabilityRow[];
  slowestJobs: SlowJob[];
  toolUsage: { totals: ToolCount[]; bySpecialist: ToolCrossTab[] };
  reviewerOutcomes: OutcomeCounts;
  contextBurn: ContextBurnRow[];
  stalls: { bySpecialist: StallGroup[]; longest: LongestStall[] };
  chains: { lengthHistogram: ChainBucket[]; epics: EpicCount[] };
}

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

export type ObserveDatasourceKind =
  | "prometheus"
  | "grafana"
  | "loki"
  | "otel_trace"
  | "specialists_forensic"
  | "aws_agentcore"
  | "substrate"
  | "static_fixture";

export interface ObserveTenantContext {
  tenantId: string;
  deploymentEnvironment: "local" | "staging" | "production" | string;
  repo?: string;
  serviceNamespace?: string;
  serviceName?: string;
}

export interface ObserveLink {
  label: string;
  href: string;
  kind?: "dashboard" | "panel" | "runbook" | "trace" | "job" | "bead" | "github" | "docs";
}

export interface ObserveFreshness {
  observedAtUnixMs?: number;
  sourceUpdatedAtUnixMs?: number;
  cachedAtUnixMs?: number;
  cacheStatus: "live" | "last_successful" | "stale" | "fixture" | "unknown";
  maxAgeMs?: number;
}

export interface ObserveDatasourceDescriptor {
  id: string;
  kind: ObserveDatasourceKind;
  title: string;
  tenant: ObserveTenantContext;
  authMode: "server_proxy" | "internal_socket" | "none";
  capabilities: ObserveSignalKind[];
  writePolicy: "read_only" | "draft_requires_approval";
  freshness: ObserveFreshness;
  links?: ObserveLink[];
}

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

export interface ObserveEvidenceContext {
  beadId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
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

export interface ObserveQueryRequest {
  datasourceId: string;
  signalKind: ObserveSignalKind;
  query: ObserveQuery;
  range: ObserveTimeRange;
  tenant: ObserveTenantContext;
  limits: ObserveQueryLimits;
  evidenceContext?: ObserveEvidenceContext;
}

export interface ObserveMetricSample {
  metric: Record<string, string>;
  value: number;
  tUnixMs: number;
}

export interface ObserveMetricSeries {
  metric: Record<string, string>;
  samples: ObserveMetricSample[];
}

export interface ObserveLogRow {
  tUnixMs: number;
  labels: Record<string, string>;
  message: string;
}

export interface ObserveTraceSummary {
  traceId: string;
  rootName: string;
  spans: Array<{ spanId: string; parentSpanId?: string; name: string; durationMs?: number }>;
}

export interface ObserveEvalSummary {
  evalId: string;
  evalKind: string;
  result: "pass" | "fail" | "partial" | "unknown";
  score?: number;
}

export interface ObserveAlertSummary {
  alertName: string;
  state: "firing" | "pending" | "resolved" | "unknown";
  severity?: "info" | "warning" | "critical" | string;
  labels: Record<string, string>;
}

export interface ObserveDashboardRef {
  dashboardUid: string;
  title: string;
  panelId?: string;
}

export interface ObserveJournalRecord {
  journalRecordId: string;
  taskId: string;
  title: string;
  tUnixMs: number;
}

export interface ObserveRecommendationRecord {
  recommendationId: string;
  taskId: string;
  title: string;
  status: "proposed" | "accepted" | "rejected" | "closed" | "completed" | "update_in_progress" | string;
  priority?: "high" | "medium" | "low" | string;
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
  | { kind: "forensic_events"; events: unknown[] }
  | { kind: "runbook"; ref: string; title: string; body?: string };

export type ObserveEvidenceKind =
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

export interface ObserveEvidenceRef {
  id: string;
  kind: ObserveEvidenceKind;
  source: string;
  title: string;
  timeRange?: ObserveTimeRange;
  queryText?: string;
  correlation?: Record<string, string>;
  redaction?: { status: "clean" | "redacted" | "unknown"; fields?: string[] };
  links?: ObserveLink[];
}

export interface ObserveDiagnostics {
  owner?: "gitboard" | "specialists" | "mercury/infra" | "substrate" | string;
  message?: string;
  warnings?: string[];
}

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
