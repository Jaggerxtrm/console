import { describe, expect, it } from "vitest";
import { SOURCE_HEALTH_STATUSES, freshnessFromSourceHealth, makeSourceHealth } from "../src/state/index.ts";

describe("core source health contract", () => {
  it("defines the canonical dashboard health vocabulary", () => {
    expect(SOURCE_HEALTH_STATUSES).toEqual(["fresh", "stale", "degraded", "unhealthy", "missing"]);
  });

  it("maps non-readable source failures to degraded freshness", () => {
    expect(freshnessFromSourceHealth("missing")).toBe("degraded");
    expect(freshnessFromSourceHealth("unhealthy")).toBe("degraded");
  });

  it("preserves checked_at, message, and metadata", () => {
    expect(makeSourceHealth("github", "degraded", {
      checked_at: "2026-01-01T00:00:00.000Z",
      message: "rate limited",
      metadata: { remaining: 10 },
    })).toEqual({
      source: "github",
      status: "degraded",
      checked_at: "2026-01-01T00:00:00.000Z",
      message: "rate limited",
      metadata: { remaining: 10 },
    });
  });
});
