import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/jsonl-reader.ts", () => ({
  readIssuesFromJsonl: vi.fn(),
}));

import { createGraphDao, resolveProject } from "../../src/core/graph-dao.ts";
import type { BeadIssue } from "../../src/types/beads.ts";
import { readIssuesFromJsonl } from "../../src/core/jsonl-reader.ts";

const mockedReadIssuesFromJsonl = vi.mocked(readIssuesFromJsonl);

describe("resolveProject", () => {
  const projects = [
    { id: "4c37df93-55bf-44d2-8ddb-9c9d0f237587", name: "gitboard", beadsPath: "/tmp/gitboard" },
    { id: "sideboard", name: "sideboard", beadsPath: "/tmp/sideboard" },
  ] as const;

  it("matches project UUID", () => {
    expect(resolveProject(projects as never, "4c37df93-55bf-44d2-8ddb-9c9d0f237587")?.name).toBe("gitboard");
  });

  it("matches project name", () => {
    expect(resolveProject(projects as never, "gitboard")?.id).toBe("4c37df93-55bf-44d2-8ddb-9c9d0f237587");
  });

  it("returns null when missing", () => {
    expect(resolveProject(projects as never, "missing")).toBeNull();
    expect(resolveProject(projects as never, undefined)).toBeNull();
  });
});

describe("graph cache identity", () => {
  it("keeps same cache across time, invalidates on epoch bump", async () => {
    vi.useFakeTimers();
    mockedReadIssuesFromJsonl.mockResolvedValue([{ ...baseIssue, id: "repo-a-1" }]);

    const dao = createGraphDao({ scanner: createScanner(), observability: { inFlightJobs: () => [] } as never });
    const first = dao.getGraphSnapshot("repo-a");
    await vi.advanceTimersByTimeAsync(11_000);
    const second = dao.getGraphSnapshot("repo-a");

    expect(first.freshness).toBe("stale");
    expect(second.graph.project_id).toBe("repo-a");

    dao.invalidate("repo-a");
    const third = dao.getGraphSnapshot("repo-a");
    expect(third.freshness).toBe("stale");
    vi.useRealTimers();
  });

  it("serves degraded cached graph after background refresh fails", async () => {
    vi.useFakeTimers();
    mockedReadIssuesFromJsonl
      .mockResolvedValueOnce([{ ...baseIssue, id: "repo-a-1" }])
      .mockRejectedValueOnce(new Error("dolt down"));

    const dao = createGraphDao({ scanner: createScanner(), observability: { inFlightJobs: () => [] } as never });
    const first = dao.getGraphSnapshot("repo-a");
    expect(first.freshness).toBe("stale");

    await vi.advanceTimersByTimeAsync(11_000);
    const second = dao.getGraphSnapshot("repo-a");

    expect(second.graph.nodes.map((node) => node.id)).toEqual(["repo-a-1"]);
    expect(second.freshness).toBe("stale");
    vi.useRealTimers();
  });

  it("returns stale immediately while cold warm runs in background", async () => {
    let scanStarted = false;
    let releaseScan!: () => void;
    const scanReady = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });

    const scanner = {
      scanDirectory: async () => {
        scanStarted = true;
        await scanReady;
        return [{ id: "repo-a", name: "repo-a", beadsPath: "/tmp/repo-a", status: "active", lastScanned: "", issueCount: 0 }];
      },
      getProject: (projectId: string) => (projectId === "repo-a" ? { id: "repo-a", name: "repo-a", beadsPath: "/tmp/repo-a", status: "active", lastScanned: "", issueCount: 0 } : null),
    } as never;

    mockedReadIssuesFromJsonl.mockResolvedValue([{ ...baseIssue, id: "repo-a-1" }]);
    const dao = createGraphDao({ scanner, observability: { inFlightJobs: () => [] } as never });

    const control = Promise.resolve(42);
    const snapshot = dao.getGraphSnapshot("repo-a");
    const controlValue = await control;

    expect(controlValue).toBe(42);
    expect(snapshot.freshness).toBe("stale");
    expect(scanStarted).toBe(true);

    releaseScan();
    await Promise.resolve();
  });

  it("shares one in-flight issue refresh across concurrent warm callers", async () => {
    // Unique project id + scanner isolate this test from module-level issue
    // cache/inflight state left over from earlier tests in this file.
    const project = { id: "repo-concurrent", name: "repo-concurrent", beadsPath: "/tmp/repo-concurrent", status: "active", lastScanned: "", issueCount: 0 };
    const scanner = {
      scanDirectory: async () => [project],
      getProject: (projectId: string) => (projectId === "repo-concurrent" ? project : null),
    } as never;

    let releaseIssues!: (issues: BeadIssue[]) => void;
    let issuesCalls = 0;
    // Clear any queued mockResolvedValueOnce/mockRejectedValueOnce left by earlier
    // tests so the controlled implementation below governs every call.
    mockedReadIssuesFromJsonl.mockReset();
    mockedReadIssuesFromJsonl.mockImplementation(() => {
      issuesCalls += 1;
      return new Promise<BeadIssue[]>((resolve) => {
        releaseIssues = resolve;
      });
    });

    const dao = createGraphDao({ scanner, observability: { inFlightJobs: () => [] } as never });

    const warm1 = dao.getGraphSnapshotWarm("repo-concurrent");
    // Drain microtasks until the first warm caller has registered the in-flight refresh.
    for (let i = 0; i < 100 && issuesCalls === 0; i += 1) await Promise.resolve();
    expect(issuesCalls).toBe(1);

    // A synchronous snapshot reader must join existing refresh without starting
    // another JSONL read; stale result remains allowed for this non-warm API.
    const stale = dao.getGraphSnapshot("repo-concurrent");
    expect(stale.freshness).toBe("stale");
    expect(stale.graph.nodes).toEqual([]);
    expect(issuesCalls).toBe(1);

    let warm2Settled = false;
    const warm2 = dao.getGraphSnapshotWarm("repo-concurrent").then((result) => {
      warm2Settled = true;
      return result;
    });
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
    // The second warm caller must join the in-flight refresh, not start a new one...
    expect(issuesCalls).toBe(1);
    // ...and must NOT settle with stale data while the shared refresh is pending.
    expect(warm2Settled).toBe(false);

    releaseIssues([{ ...baseIssue, id: "repo-concurrent-1" }]);
    const [first, second] = await Promise.all([warm1, warm2]);

    // Both concurrent callers observe the refreshed (fresh) snapshot.
    expect(first.freshness).toBe("fresh");
    expect(second.freshness).toBe("fresh");
    expect(second.graph.nodes.map((node) => node.id)).toEqual(["repo-concurrent-1"]);
    expect(issuesCalls).toBe(1);
  });
});

const baseIssue: BeadIssue = {
  id: "repo-a-issue",
  title: "issue",
  description: null,
  notes: null,
  status: "open",
  priority: 1,
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  closed_at: undefined,
  close_reason: undefined,
  project_id: "repo-a",
  dependencies: [],
  related_ids: [],
  labels: [],
};

function createScanner() {
  return {
    scanDirectory: async () => [{ id: "repo-a", name: "repo-a", beadsPath: "/tmp/repo-a", status: "active", lastScanned: "", issueCount: 0 }],
    getProject: (projectId: string) => (projectId === "repo-a" ? { id: "repo-a", name: "repo-a", beadsPath: "/tmp/repo-a", status: "active", lastScanned: "", issueCount: 0 } : null),
  } as never;
}
