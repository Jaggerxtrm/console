import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BeadsWatcherRuntime,
  BEADS_WATCHER_MAX_BATCH,
  type BeadsWatcherPorts,
  type BeadsWatcherProject,
  type BeadsWatcherSnapshot,
} from "../src/runtime/beads-watcher.ts";

type Publish = { event: string; data: unknown };

async function waitUntil(check: () => boolean, advanceMs?: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (check()) return;
    if (advanceMs === undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } else {
      await vi.advanceTimersByTimeAsync(advanceMs);
      await Promise.resolve();
    }
  }
  throw new Error("condition did not become true");
}

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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggerMaterializer short-circuits poll and skips snapshot reads", async () => {
    vi.useFakeTimers();
    let triggerCalls = 0;
    let lastTriggeredId: string | undefined;
    const { ports } = makeHarness({
      projects: [makeProject("p1")],
      triggerMaterializer: (project) => { triggerCalls += 1; lastTriggeredId = project.id; },
      readSnapshot: async () => { throw new Error("readSnapshot must not run on trigger path"); },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 10_000 });
    runtime.start();
    await waitUntil(() => triggerCalls === 1, 0);
    runtime.stop();

    expect(runtime.isStopped()).toBe(true);
    expect(triggerCalls).toBe(1);
    expect(lastTriggeredId).toBe("p1");
  });

  it("triggers first and commit-change polls, but skips unchanged trigger heartbeats", async () => {
    vi.useFakeTimers();
    const project = makeProject("p1");
    let triggerCalls = 0;
    let commitHashReads = 0;
    let commitHash = "initial";
    const { ports } = makeHarness({
      projects: [project],
      readCommitHash: async () => {
        commitHashReads += 1;
        return commitHash;
      },
      triggerMaterializer: () => { triggerCalls += 1; },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 15, coalesceMs: 10 });
    runtime.start();
    await waitUntil(() => triggerCalls === 1, 0);
    await waitUntil(() => commitHashReads >= 2, 15);
    expect(triggerCalls).toBe(1);

    commitHash = "changed";
    await waitUntil(() => triggerCalls === 2, 15);
    runtime.stop();

    expect(commitHashReads).toBeGreaterThan(2);
    expect(triggerCalls).toBe(2);
  });

  it("triggers fs changes after debounce and stop prevents later fs work", async () => {
    const beadsPath = mkdtempSync(join(tmpdir(), "beads-watcher-trigger-"));
    const issuesPath = join(beadsPath, "issues.jsonl");
    writeFileSync(issuesPath, "\n");
    const project = { id: "p1", beadsPath };
    let triggerCalls = 0;
    const { ports } = makeHarness({
      projects: [project],
      readCommitHash: async () => "unchanged",
      triggerMaterializer: () => { triggerCalls += 1; },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 60_000, debounceMs: 10, coalesceMs: 10 });
    runtime.start();
    await waitUntil(() => triggerCalls === 1);
    appendFileSync(issuesPath, "changed\n");
    await waitUntil(() => triggerCalls === 2);
    runtime.stop();
    appendFileSync(issuesPath, "stopped\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(triggerCalls).toBe(2);
    rmSync(beadsPath, { recursive: true, force: true });
  });

  it("skips readSnapshot when commit hash unchanged and snapshot cached", async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    const project = makeProject("p1");
    const { ports, published } = makeHarness({
      projects: [project],
      readCommitHash: async () => "abc",
      readSnapshot: async () => { snapshotCalls += 1; return emptySnapshot(); },
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 15, coalesceMs: 10 });
    runtime.start();
    await waitUntil(() => snapshotCalls === 1, 0);
    await vi.advanceTimersByTimeAsync(15);
    runtime.stop();

    // first poll reads snapshot (no prior hash); subsequent polls hit the
    // commit-hash fast path and never call readSnapshot.
    expect(snapshotCalls).toBe(1);
    expect(published.some((p) => p.event === "beads:source_health")).toBe(true);
  });

  it("diffs initial snapshot with initialized log and upsert events", async () => {
    vi.useFakeTimers();
    const project = makeProject("p1");
    const { ports, published, logs } = makeHarness({
      projects: [project],
      readSnapshot: async () => ({ issues: [issue("1", "open"), issue("2", "in_progress")], deps: [], memories: [], kv: [] }),
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 15 });
    runtime.start();
    await waitUntil(() => logs.includes("beads.snapshot.initialized"), 0);
    await vi.advanceTimersByTimeAsync(15);
    runtime.stop();

    expect(logs).toContain("beads.snapshot.initialized");
    expect(published.some((p) => p.event === "beads:issue.upsert")).toBe(true);
  });

  it("detects close and flagged transitions on second snapshot", async () => {
    vi.useFakeTimers();
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
    await waitUntil(() => readCalls === 1, 0);
    await waitUntil(() => readCalls === 2, 15);
    await vi.advanceTimersByTimeAsync(10);
    runtime.stop();

    const events = published.map((p) => p.event);
    expect(events).toContain("beads:issue.close");
    expect(events).toContain("beads:issue.flagged");
  });

  it("flush coalesces a single batch publish across events", async () => {
    vi.useFakeTimers();
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
    await waitUntil(() => published.some((p) => p.event === "beads:issue.upsert"), 20);
    await vi.advanceTimersByTimeAsync(20);
    runtime.stop();

    const batches = published.filter((p) => p.event === "beads:batch");
    expect(batches.length).toBe(1);
    expect(((batches[0].data as { issues: unknown[] }).issues).length).toBe(3);
  });

  it("overflow beyond MAX_BATCH publishes substrate:sync_hint and skips batch", async () => {
    vi.useFakeTimers();
    const project = makeProject("p1");
    const many = Array.from({ length: BEADS_WATCHER_MAX_BATCH + 5 }, (_, i) => issue(String(i), "open"));
    const { ports, published } = makeHarness({
      projects: [project],
      readCommitHash: async () => "v1",
      readSnapshot: async () => ({ issues: many, deps: [], memories: [], kv: [] }),
    });
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 10_000, coalesceMs: 10_000 });
    runtime.start();
    await waitUntil(() => published.some((p) => p.event === "substrate:sync_hint"), 0);
    runtime.stop();

    expect(published.some((p) => p.event === "substrate:sync_hint")).toBe(true);
    expect(published.some((p) => p.event === "beads:batch")).toBe(false);
  });

  it("stop clears pending debounce timer before it can poll after fs event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
    const runtime = new BeadsWatcherRuntime(ports, { activePollMs: 60_000, debounceMs: 200, coalesceMs: 10_000 });
    runtime.start();
    await waitUntil(() => readSnapshotCalls === 1, 0);
    appendFileSync(issuesPath, "x\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.stop();
    vi.advanceTimersByTime(201);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.isStopped()).toBe(true);
    expect(readSnapshotCalls).toBe(1);
    expect(pollReads).toBe(1);
    rmSync(beadsPath, { recursive: true, force: true });
  });
});
