import { describe, expect, it } from "vitest";
import { makeSourceHealth } from "../src/state/index.ts";
import { summarizeSourceHealth, type SourceDescriptor } from "../src/runtime/index.ts";

describe("source lifecycle contracts", () => {
  it("summarizes degraded, missing, and healthy sources without leaking paths", () => {
    const sources: SourceDescriptor[] = [
      { sourceKey: "beads:repo-a", kind: "beads", repoSlug: "repo-a", displayPath: "~/repo-a/.beads", status: "active", health: makeSourceHealth("beads", "fresh") },
      { sourceKey: "obs:repo-b", kind: "observability", repoSlug: "repo-b", displayPath: "~/repo-b/.specialists", status: "degraded", health: makeSourceHealth("observability", "degraded") },
      { sourceKey: "github:repo-c", kind: "github", repoSlug: "repo-c", displayPath: "owner/repo-c", status: "missing", health: makeSourceHealth("github", "missing") },
    ];

    expect(summarizeSourceHealth(sources)).toEqual({ total: 3, degraded: 1, missing: 1, healthy: 1 });
  });
});
