import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BeadsWatcherRuntime,
  BEADS_WATCHER_MAX_BATCH,
  type BeadsWatcherPorts,
  type BeadsWatcherProject,
  type BeadsWatcherSnapshot,
} from "../src/runtime/beads-watcher.ts";

type Publish = { event: string; data: unknown };

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function emptySnapshot(): BeadsWatcherSnapshot {
  return { issues: [], deps: [], memories: [], kv: [] };
}

let pathCounter = 0;
function makeProject(id: string): BeadsWatcherProject {
  pathCounter += 1;
  // Non-existent path: fs.watch throws ENOENT (caught), so no real watcher is
  // created and stop() has nothing to close — keeps the test deterministic.
  return { id, beadsPath: `/tmp/beads-watch-test-${id}-${pathCounter}` };
}

function issue(id: string, status: string, extra: Partial<{ updated_at: string; labels: string[]; parent_id: string }> = {}) {
  return {
    id,
    title: `issue ${id}`,
    status,
    priority: 2,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    labels: [] as string[],
    parent_id: undefined as string | undefined,
    ...extra,
  };
}

function makeHarness(overrides: Partial<BeadsWatcherPorts> & { projects?: BeadsWatcherProject[] } = {}) {
  const published: Publish[] = [];
  const logs: string[] = [];
  const projects = overrides.projects ?? [];
  const ports: BeadsWatcherPorts = {
    scanProjects: async () => projects,
    readSnapshot: async () => emptySnapshot(),
    readCommitHash: async () => null,
    publish: (_channel, event, data) => published.push({ event, data }),
    emitLog: (entry) => logs.push(entry.event),
    ...overrides,
  };
  return { ports, published, logs };
}

describe("BeadsWatcherRuntime", () => {
  it("triggerMaterializer short-circuits poll and skips snapshot reads", async () => {
    let triggerCalls = 0;
    let lastTriggeredId: string | undefined;
    const { ports } = makeHarness({
      projects: [makeProject("p1")],
      triggerMaterializer: (project) => { triggerCalls += 1; lastTriggeredId = project.id; },
      readSnapshot: async () => { throw new Error("readSnapshot must not run on trigger path"); },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 10_000 });
    runtime.start();
    await wait(30);
    runtime.stop();

    expect(runtime.isStopped()).toBe(true);
    expect(triggerCalls).toBe(1);
    expect(lastTriggeredId).toBe("p1");
  });

  it("skips readSnapshot when commit hash unchanged and snapshot cached", async () => {
    let snapshotCalls = 0;
    const project = makeProject("p1");
    const { ports, published } = makeHarness({
      projects: [project],
      readCommitHash: async () => "abc",
      readSnapshot: async () => { snapshotCalls += 1; return emptySnapshot(); },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 15, coalesceMs: 10 });
    runtime.start();
    await wait(60);
    runtime.stop();

    // first poll reads snapshot (no prior hash); subsequent polls hit the
    // commit-hash fast path and never call readSnapshot.
    expect(snapshotCalls).toBe(1);
    expect(published.some((p) => p.event === "beads:source_health")).toBe(true);
  });

  it("diffs initial snapshot with initialized log and upsert events", async () => {
    const project = makeProject("p1");
    const { ports, published, logs } = makeHarness({
      projects: [project],
      readSnapshot: async () => ({ issues: [issue("1", "open"), issue("2", "in_progress")], deps: [], memories: [], kv: [] }),
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 15 });
    runtime.start();
    await wait(40);
    runtime.stop();

    expect(logs).toContain("beads.snapshot.initialized");
    expect(published.some((p) => p.event === "beads:issue.upsert")).toBe(true);
  });

  it("detects close and flagged transitions on second snapshot", async () => {
    const project = makeProject("p1");
    const snapshots: BeadsWatcherSnapshot[] = [
      { issues: [issue("1", "open", { labels: [] })], deps: [], memories: [], kv: [] },
      { issues: [issue("1", "closed", { labels: ["x"] })], deps: [], memories: [], kv: [] },
    ];
    let readCalls = 0;
    let hashCounter = 0;
    const { ports, published } = makeHarness({
      projects: [project],
      readSnapshot: async () => snapshots[Math.min(readCalls++, snapshots.length - 1)],
      readCommitHash: async () => `v${hashCounter++}`,
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 15, coalesceMs: 10 });
    runtime.start();
    await wait(70);
    runtime.stop();

    const events = published.map((p) => p.event);
    expect(events).toContain("beads:issue.close");
    expect(events).toContain("beads:issue.flagged");
  });

  it("flush coalesces a single batch publish across events", async () => {
    const project = makeProject("p1");
    const { ports, published } = makeHarness({
      projects: [project],
      readCommitHash: async () => `v${Date.now()}`,
      readSnapshot: async () => ({
        issues: [issue("1", "open"), issue("2", "open"), issue("3", "open")],
        deps: [],
        memories: [],
        kv: [],
      }),
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 20 });
    runtime.start();
    await wait(50);
    runtime.stop();

    const batches = published.filter((p) => p.event === "beads:batch");
    expect(batches.length).toBe(1);
    expect(((batches[0].data as { issues: unknown[] }).issues).length).toBe(3);
  });

  it("overflow beyond MAX_BATCH publishes substrate:sync_hint and skips batch", async () => {
    const project = makeProject("p1");
    const many = Array.from({ length: BEADS_WATCHER_MAX_BATCH + 5 }, (_, i) => issue(String(i), "open"));
    const { ports, published } = makeHarness({
      projects: [project],
      readCommitHash: async () => "v1",
      readSnapshot: async () => ({ issues: many, deps: [], memories: [], kv: [] }),
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 10_000 });
    runtime.start();
    await wait(30);
    runtime.stop();

    expect(published.some((p) => p.event === "substrate:sync_hint")).toBe(true);
    expect(published.some((p) => p.event === "beads:batch")).toBe(false);
  });

  it("stop clears pending debounce timer before it can poll after fs event", async () => {
    const beadsPath = mkdtempSync(join(tmpdir(), "beads-watcher-stop-"));
    const issuesPath = join(beadsPath, "issues.jsonl");
    writeFileSync(issuesPath, "\n");
    const project = { id: "p1", beadsPath };
    let readSnapshotCalls = 0;
    let pollReads = 0;
    const { ports } = makeHarness({
      projects: [project],
      readCommitHash: async () => "v1",
      readSnapshot: async () => {
        readSnapshotCalls += 1;
        pollReads += 1;
        return { issues: [issue("1", "open")], deps: [], memories: [], kv: [] };
      },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, debounceMs: 200, coalesceMs: 10_000 });
    runtime.start();
    await wait(30);
    appendFileSync(issuesPath, "x\n");
    await wait(20);
    runtime.stop();
    await wait(300);

    expect(runtime.isStopped()).toBe(true);
    expect(readSnapshotCalls).toBe(1);
    expect(pollReads).toBe(1);
    rmSync(beadsPath, { recursive: true, force: true });
  });
});
