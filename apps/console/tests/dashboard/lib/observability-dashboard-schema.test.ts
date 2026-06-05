import { describe, expect, it } from "vitest";

import {
  legacyObserveDashboardFixture,
  migrateObserveDashboardSpec,
  observeDashboardFixture,
  OBSERVE_DASHBOARD_SCHEMA_VERSION,
  validateObserveDashboardSpec,
} from "../../../src/dashboard/lib/observability-dashboard-schema.ts";

describe("observability dashboard schema", () => {
  it("accepts the phase 0 fixture dashboard spec", () => {
    const result = validateObserveDashboardSpec(observeDashboardFixture);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.spec?.schemaVersion).toBe(OBSERVE_DASHBOARD_SCHEMA_VERSION);
  });

  it("migrates legacy v0 fixtures into the current schema", () => {
    const result = migrateObserveDashboardSpec(legacyObserveDashboardFixture);

    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(true);
    expect(result.spec?.schemaVersion).toBe(OBSERVE_DASHBOARD_SCHEMA_VERSION);
    expect(result.spec?.panels[0]?.type).toBe("timeseries");
  });

  it("rejects invalid panel types", () => {
    const result = validateObserveDashboardSpec({
      ...observeDashboardFixture,
      panels: [{ ...observeDashboardFixture.panels[0], type: "sparkle_cloud" }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("panel.runtime-state.invalid_panel_type");
  });

  it("rejects unknown datasource ids", () => {
    const result = validateObserveDashboardSpec({
      ...observeDashboardFixture,
      panels: [{ ...observeDashboardFixture.panels[0], datasourceId: "missing-datasource" }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("panel.runtime-state.unknown_datasource");
  });

  it("rejects unsafe panel queries", () => {
    const result = validateObserveDashboardSpec({
      ...observeDashboardFixture,
      panels: [
        {
          ...observeDashboardFixture.panels[0],
          query: { kind: "promql", expr: 'xtrm_job_duration_seconds{trace_id="trace-fixture-001"}' },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("panel.runtime-state.forbidden_high_cardinality_label");
  });

  it("rejects agent-authored persistence without operator approval", () => {
    const result = validateObserveDashboardSpec({
      ...observeDashboardFixture,
      lifecycle: {
        state: "approved",
        authoredBy: "agent",
        persistRequested: true,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("agent_persistence_requires_operator_approval");
  });
});
