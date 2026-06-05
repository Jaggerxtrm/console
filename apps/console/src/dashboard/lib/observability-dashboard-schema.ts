import type {
  ObserveDatasourceDescriptor,
  ObserveQuery,
  ObserveSignalKind,
} from "../../types/observability.ts";
import {
  observeFixtureRange,
  observeFixtureTenant,
  observeStaticFixtureDatasource,
  validateObserveQueryRequest,
} from "./observability-datasource.ts";

export const OBSERVE_DASHBOARD_SCHEMA_VERSION = "xtrm.observe.dashboard.v1";

export type ObservePanelType =
  | "stat"
  | "timeseries"
  | "table"
  | "log_stream"
  | "trace_waterfall"
  | "evidence_list"
  | "alert_list"
  | "journal"
  | "recommendations";

export interface ObserveDashboardPanelSpec {
  id: string;
  title: string;
  type: ObservePanelType;
  datasourceId: string;
  signalKind: ObserveSignalKind;
  query: ObserveQuery;
}

export interface ObserveDashboardLifecycle {
  state: "draft" | "approved";
  authoredBy: "operator" | "agent";
  persistRequested: boolean;
  operatorApprovedBy?: string;
}

export interface ObserveDashboardSpecV1 {
  schemaVersion: typeof OBSERVE_DASHBOARD_SCHEMA_VERSION;
  id: string;
  title: string;
  lifecycle: ObserveDashboardLifecycle;
  panels: ObserveDashboardPanelSpec[];
}

export interface ObserveDashboardValidationResult {
  ok: boolean;
  errors: string[];
  migrated?: boolean;
  spec?: ObserveDashboardSpecV1;
}

export interface LegacyObserveDashboardSpecV0 {
  schema_version: "xtrm.observe.dashboard.v0";
  id: string;
  title: string;
  approval_state?: "draft" | "approved";
  authored_by?: "operator" | "agent";
  panels: Array<{
    id: string;
    title: string;
    panel_type: ObservePanelType;
    datasource_id: string;
    signal_kind: ObserveSignalKind;
    query: ObserveQuery;
  }>;
}

export const observeDashboardFixture: ObserveDashboardSpecV1 = {
  schemaVersion: OBSERVE_DASHBOARD_SCHEMA_VERSION,
  id: "agentops-phase0-fixture",
  title: "AgentOps Phase 0 Fixture",
  lifecycle: {
    state: "draft",
    authoredBy: "agent",
    persistRequested: false,
  },
  panels: [
    {
      id: "runtime-state",
      title: "Runtime State",
      type: "timeseries",
      datasourceId: observeStaticFixtureDatasource.id,
      signalKind: "metric",
      query: { kind: "promql", expr: "sum by (repo, participant_role, state) (xtrm_job_state)" },
    },
    {
      id: "forensic-events",
      title: "Forensic Events",
      type: "evidence_list",
      datasourceId: observeStaticFixtureDatasource.id,
      signalKind: "forensic_event",
      query: { kind: "forensic_events", jobId: "job-fixture-001" },
    },
  ],
};

export const legacyObserveDashboardFixture: LegacyObserveDashboardSpecV0 = {
  schema_version: "xtrm.observe.dashboard.v0",
  id: "agentops-legacy-fixture",
  title: "AgentOps Legacy Fixture",
  approval_state: "draft",
  authored_by: "agent",
  panels: [
    {
      id: "runtime-state",
      title: "Runtime State",
      panel_type: "timeseries",
      datasource_id: observeStaticFixtureDatasource.id,
      signal_kind: "metric",
      query: { kind: "promql", expr: "sum by (repo, participant_role, state) (xtrm_job_state)" },
    },
  ],
};

export function migrateObserveDashboardSpec(input: unknown): ObserveDashboardValidationResult {
  if (isObserveDashboardSpecV1(input)) {
    return { ok: true, errors: [], migrated: false, spec: input };
  }

  if (!isLegacyObserveDashboardSpecV0(input)) {
    return { ok: false, errors: ["unsupported_schema_version"] };
  }

  return {
    ok: true,
    errors: [],
    migrated: true,
    spec: {
      schemaVersion: OBSERVE_DASHBOARD_SCHEMA_VERSION,
      id: input.id,
      title: input.title,
      lifecycle: {
        state: input.approval_state ?? "draft",
        authoredBy: input.authored_by ?? "agent",
        persistRequested: false,
      },
      panels: input.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        type: panel.panel_type,
        datasourceId: panel.datasource_id,
        signalKind: panel.signal_kind,
        query: panel.query,
      })),
    },
  };
}

export function validateObserveDashboardSpec(
  input: unknown,
  datasources: ObserveDatasourceDescriptor[] = [observeStaticFixtureDatasource],
): ObserveDashboardValidationResult {
  const migration = migrateObserveDashboardSpec(input);

  if (!migration.ok || !migration.spec) {
    return migration;
  }

  const errors: string[] = [];
  const spec = migration.spec;
  const datasourceById = new Map(datasources.map((datasource) => [datasource.id, datasource]));

  if (!spec.id) errors.push("dashboard_id_required");
  if (!spec.title) errors.push("dashboard_title_required");
  if (spec.lifecycle.state !== "draft" && spec.lifecycle.state !== "approved") errors.push("invalid_lifecycle_state");

  if (spec.lifecycle.authoredBy === "agent" && spec.lifecycle.persistRequested && !spec.lifecycle.operatorApprovedBy) {
    errors.push("agent_persistence_requires_operator_approval");
  }

  if (spec.panels.length === 0) {
    errors.push("panels_required");
  }

  for (const panel of spec.panels) {
    if (!isObservePanelType(panel.type)) {
      errors.push(`panel.${panel.id}.invalid_panel_type`);
    }

    const datasource = datasourceById.get(panel.datasourceId);

    if (!datasource) {
      errors.push(`panel.${panel.id}.unknown_datasource`);
      continue;
    }

    const queryGuard = validateObserveQueryRequest({
      datasourceId: panel.datasourceId,
      signalKind: panel.signalKind,
      query: panel.query,
      range: observeFixtureRange,
      tenant: observeFixtureTenant,
      limits: { maxRows: 50, maxBytes: 64_000, timeoutMs: 2_000 },
    }, datasource);

    for (const error of queryGuard.errors) {
      errors.push(`panel.${panel.id}.${error}`);
    }
  }

  return { ok: errors.length === 0, errors, migrated: migration.migrated, spec };
}

function isObserveDashboardSpecV1(input: unknown): input is ObserveDashboardSpecV1 {
  return typeof input === "object" && input !== null && (input as ObserveDashboardSpecV1).schemaVersion === OBSERVE_DASHBOARD_SCHEMA_VERSION;
}

function isLegacyObserveDashboardSpecV0(input: unknown): input is LegacyObserveDashboardSpecV0 {
  return typeof input === "object" && input !== null && (input as LegacyObserveDashboardSpecV0).schema_version === "xtrm.observe.dashboard.v0";
}

function isObservePanelType(value: string): value is ObservePanelType {
  return [
    "stat",
    "timeseries",
    "table",
    "log_stream",
    "trace_waterfall",
    "evidence_list",
    "alert_list",
    "journal",
    "recommendations",
  ].includes(value);
}
