import { describe, expect, it } from "vitest";
import { makeSourceHealth } from "../src/state/index.ts";
import { buildBeadsSourceHealthEvent, buildSourceHealthChangedPayload, canRefreshSources, createSourceRefreshState, decideBeadsSourceRead, formatSourceDisplayPath, getMissingDiscoveredSourceKeys, normalizeLegacySourceStatus, summarizeSourceHealth, summarizeSourceRefresh, type SourceDescriptor } from "../src/runtime/index.ts";

describe("source lifecycle contracts", () => {
  it("summarizes degraded, missing, and healthy sources without leaking paths", () => {
    const sources: SourceDescriptor[] = [
      { sourceKey: "beads:repo-a", kind: "beads", repoSlug: "repo-a", displayPath: "~/repo-a/.beads", status: "active", health: makeSourceHealth("beads", "fresh") },
      { sourceKey: "obs:repo-b", kind: "observability", repoSlug: "repo-b", displayPath: "~/repo-b/.specialists", status: "degraded", health: makeSourceHealth("observability", "degraded") },
      { sourceKey: "github:repo-c", kind: "github", repoSlug: "repo-c", displayPath: "owner/repo-c", status: "missing", health: makeSourceHealth("github", "missing") },
    ];

    expect(summarizeSourceHealth(sources)).toEqual({ total: 3, degraded: 1, missing: 1, healthy: 1 });
  });

  it("redacts display paths consistently", () => {
    expect(formatSourceDisplayPath("/very/private/workspace/demo/.beads")).toBe("…/demo/.beads");
    expect(formatSourceDisplayPath("/repo")).toBe("/repo");
  });

  it("tracks refresh state and cooldown gates", () => {
    const state = createSourceRefreshState();
    expect(state).toEqual({ inFlight: null, lastCompletedAt: 0 });

    expect(canRefreshSources(10_000, state)).toEqual({ ok: true });

    state.inFlight = Promise.resolve();
    expect(canRefreshSources(10_000, state)).toEqual({ ok: false, status: 202, body: { error: "refresh in progress" } });

    state.inFlight = null;
    state.lastCompletedAt = 10_000;
    expect(canRefreshSources(10_500, state)).toEqual({ ok: false, status: 429, body: { error: "refresh cooldown", retry_after_ms: 1500 } });
    expect(canRefreshSources(13_000, state)).toEqual({ ok: true });
  });

  it("normalizes legacy source status", () => {
    expect(normalizeLegacySourceStatus("idle")).toBe("active");
    expect(normalizeLegacySourceStatus("missing")).toBe("missing");
  });

  it("reconciles missing discovered source keys", () => {
    expect(getMissingDiscoveredSourceKeys(["beads:a", "beads:b"], ["beads:b", "beads:c", "beads:a", "beads:d"])).toEqual(["beads:c", "beads:d"]);
  });

  it("summarizes refresh discovery payloads", () => {
    expect(summarizeSourceRefresh([{ kind: "beads" }, { kind: "observability" }, { kind: "beads" }])).toEqual({ total: 3, kinds: { beads: 2, observability: 1 } });
  });

  it("decides unchanged commit skips and event payloads", () => {
    expect(decideBeadsSourceRead("abc", "abc", true)).toEqual({ shouldSkipRead: true, source: "dolt" });
    expect(decideBeadsSourceRead(null, null, false)).toEqual({ shouldSkipRead: false, source: "jsonl" });
    expect(buildBeadsSourceHealthEvent("p1", "abc", true, true)).toEqual({ projectId: "p1", source: "dolt", drift: true, healthy: true });
    expect(buildSourceHealthChangedPayload("p1", true, "dolt")).toEqual({ projectId: "p1", healthy: true, source: "dolt" });
  });
});
