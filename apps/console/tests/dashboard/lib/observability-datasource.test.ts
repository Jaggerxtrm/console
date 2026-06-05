import { describe, expect, it } from "vitest";

import {
  createObserveFixtureRequest,
  observeStaticFixtureDatasource,
  queryStaticObserveDatasource,
} from "../../../src/dashboard/lib/observability-datasource.ts";
import type { ObserveSignalKind } from "../../../src/types/observability.ts";

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
