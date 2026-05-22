import { describe, expect, it } from "vitest";
import { SOURCE_HEALTH_STATUSES, freshnessFromSourceHealth, makeSourceHealth } from "../../src/types/source-health.ts";

describe("source health", () => {
  it("defines the canonical dashboard health vocabulary", () => {
    expect(SOURCE_HEALTH_STATUSES).toEqual(["fresh", "stale", "degraded", "unhealthy", "missing"]);
  });

  it("maps terminal source failures to degraded resource freshness", () => {
    expect(freshnessFromSourceHealth("missing")).toBe("degraded");
    expect(freshnessFromSourceHealth("unhealthy")).toBe("degraded");
  });

  it("preserves per-source metadata", () => {
    expect(makeSourceHealth("github", "degraded", { checked_at: "2026-01-01T00:00:00.000Z", metadata: { remaining: 10 } })).toEqual({
      source: "github",
      status: "degraded",
      checked_at: "2026-01-01T00:00:00.000Z",
      metadata: { remaining: 10 },
    });
  });
});
