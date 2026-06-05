import { describe, expect, it } from "vitest";

import {
  createMissingSignalResponse,
  createObserveFixtureRequest,
  observeStaticFixtureDatasource,
  queryStaticObserveDatasource,
  validateObserveAgentAuthoredWrite,
  validateObserveDatasourceDescriptor,
  validateObserveQueryRequest,
} from "../../../src/dashboard/lib/observability-datasource.ts";
import type { ObserveDatasourceDescriptor, ObserveQueryRequest, ObserveSignalKind } from "../../../src/types/observability.ts";

const signalKinds: ObserveSignalKind[] = [
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
];

describe("static observability datasource", () => {
  it("declares every contract signal as read-only fixture capability", () => {
    expect(observeStaticFixtureDatasource.authMode).toBe("none");
    expect(observeStaticFixtureDatasource.writePolicy).toBe("read_only");
    expect(observeStaticFixtureDatasource.freshness.cacheStatus).toBe("fixture");
    expect(observeStaticFixtureDatasource.capabilities).toEqual(signalKinds);
  });

  it("returns representative data and evidence for every signal kind", () => {
    for (const signalKind of signalKinds) {
      const request = createObserveFixtureRequest(signalKind);
      const response = queryStaticObserveDatasource(request);

      expect(response.status).toBe("ok");
      expect(response.signalKind).toBe(signalKind);
      expect(response.data.kind).toBe(expectedDataKind(signalKind));
      expect(response.evidence).toHaveLength(1);
      expect(response.evidence[0]?.correlation?.job_id).toBe("job-fixture-001");
      expect(response.evidence[0]?.queryText).toBeTruthy();
    }
  });

  it("rejects unbounded ranges and missing result limits", () => {
    const unbounded = createObserveFixtureRequest("metric");
    unbounded.range = { fromUnixMs: 0, toUnixMs: Date.UTC(2026, 5, 6) };

    expect(validateObserveQueryRequest(unbounded).errors).toContain("range_too_large");

    const missingLimits = { ...createObserveFixtureRequest("metric"), limits: {} } as ObserveQueryRequest;

    expect(validateObserveQueryRequest(missingLimits).errors).toEqual(
      expect.arrayContaining(["maxBytes_required", "maxRows_required", "timeoutMs_required"]),
    );
  });

  it("rejects high-cardinality labels in prometheus-facing queries", () => {
    const request = createObserveFixtureRequest("metric");
    request.query = { kind: "promql", expr: 'xtrm_job_duration_seconds{job_id="job-fixture-001"}' };

    const guard = validateObserveQueryRequest(request);

    expect(guard.ok).toBe(false);
    expect(guard.errors).toContain("forbidden_high_cardinality_label");
    expect(queryStaticObserveDatasource(request).status).toBe("error");
  });

  it("keeps browser credentials out of datasource descriptors", () => {
    expect(validateObserveDatasourceDescriptor(observeStaticFixtureDatasource).ok).toBe(true);

    const unsafeNetworkedDatasource: ObserveDatasourceDescriptor = {
      ...observeStaticFixtureDatasource,
      id: "unsafe-prometheus",
      kind: "prometheus",
      authMode: "none",
    };

    expect(validateObserveDatasourceDescriptor(unsafeNetworkedDatasource).errors).toContain("networked_datasource_requires_proxy_or_socket");
  });

  it("rejects agent-authored writes without draft policy and operator approval", () => {
    expect(
      validateObserveAgentAuthoredWrite(observeStaticFixtureDatasource, {
        agentAuthored: true,
        operatorApproved: false,
      }).errors,
    ).toEqual(expect.arrayContaining(["agent_authored_write_requires_draft_policy", "agent_authored_write_requires_operator_approval"]));

    expect(
      validateObserveAgentAuthoredWrite(
        { ...observeStaticFixtureDatasource, writePolicy: "draft_requires_approval" },
        { agentAuthored: true, operatorApproved: true },
      ).ok,
    ).toBe(true);
  });

  it("routes missing signals with owner diagnostics and redacted evidence", () => {
    const request = createObserveFixtureRequest("trace");
    const response = createMissingSignalResponse(request, "mercury/infra");

    expect(response.status).toBe("missing_signal");
    expect(response.diagnostics?.owner).toBe("mercury/infra");
    expect(response.evidence[0]?.redaction?.status).toBe("unknown");
  });
});

function expectedDataKind(signalKind: ObserveSignalKind) {
  switch (signalKind) {
    case "metric":
      return "metric_matrix";
    case "log":
      return "logs";
    case "trace":
      return "trace";
    case "eval":
      return "eval";
    case "alert":
      return "alerts";
    case "dashboard":
      return "dashboard_ref";
    case "journal":
      return "journal";
    case "recommendation":
      return "recommendations";
    case "runbook":
      return "runbook";
    case "forensic_event":
      return "forensic_events";
  }
}
