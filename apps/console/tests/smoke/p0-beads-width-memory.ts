import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectScanner } from "../../../../packages/core/src/runtime/project-scanner.ts";
import type { BeadsProject } from "../../../../packages/core/src/types/beads.ts";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { readBeadsIssuesFromJsonl } from "../../../../packages/core/src/state/beads-jsonl-reader.ts";
import { BeadsAdapter } from "../../../../packages/core/src/materializer/beads-adapter.ts";
import { Materializer } from "../../../../packages/core/src/materializer/materializer.ts";
import { COALESCE_MS } from "../../../../packages/core/src/materializer/queue.ts";
import { BeadsWatcherRuntime } from "../../../../packages/core/src/runtime/beads-watcher.ts";

type Db = ReturnType<typeof createXtrmDatabase>;
type Sample = {
  phase: string;
  rss_bytes: number;
  heap_used_bytes: number;
  materializer_runs: number;
  materialized_rows: number;
  materialized_sources: number;
  watcher_commit_hash_reads: number;
  scheduler_active: number;
  scheduler_pending: number;
  scheduler_max_active: number;
  scheduler_max_pending: number;
};

const SOURCE_COUNT = 21;
const ROWS_PER_SOURCE = 500;
const EXPECTED_TOTAL_ROWS = SOURCE_COUNT * ROWS_PER_SOURCE;
if (EXPECTED_TOTAL_ROWS !== 10_500) throw new Error(`fixture width drifted: expected 10,500 total rows, got ${EXPECTED_TOTAL_ROWS}`);
const EQUIVALENT_HEARTBEAT_MS = 30;
const UNCHANGED_CYCLES = 3;
const RSS_HEADROOM_BYTES = 256 * 1024 * 1024;
const HEAP_HEADROOM_BYTES = 128 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function memorySample(
  phase: string,
  db: Db,
  materializer: Materializer,
  runCount: number,
  commitHashReads: number,
): Sample {
  const memory = process.memoryUsage();
  const scheduler = materializer.getSchedulerStats();
  const rowCount = Number((db.query("SELECT COUNT(*) AS count FROM substrate_issues WHERE deleted_at IS NULL").get() as { count: number }).count);
  const sourceCount = Number((db.query("SELECT COUNT(*) AS count FROM materialization_state WHERE last_status = 'success'").get() as { count: number }).count);
  return {
    phase,
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    materializer_runs: runCount,
    materialized_rows: rowCount,
    materialized_sources: sourceCount,
    watcher_commit_hash_reads: commitHashReads,
    scheduler_active: scheduler.active,
    scheduler_pending: scheduler.pending,
    scheduler_max_active: scheduler.maxActive,
    scheduler_max_pending: scheduler.maxPending,
  };
}

function writeFixture(root: string, sourceIndex: number): { id: string; beadsPath: string } {
  const id = `fixture-${String(sourceIndex).padStart(2, "0")}`;
  const beadsPath = join(root, id, ".beads");
  mkdirSync(beadsPath, { recursive: true });
  writeFileSync(join(beadsPath, "metadata.json"), JSON.stringify({ project_id: id }));
  const lines = Array.from({ length: ROWS_PER_SOURCE }, (_, rowIndex) => JSON.stringify({
    _type: "issue",
    id: `${id}-${String(rowIndex).padStart(5, "0")}`,
    title: `fixture issue ${rowIndex}`,
    description: null,
    notes: null,
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: null,
    dependencies: [],
    related_ids: [],
    labels: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  })).join("\n");
  writeFileSync(join(beadsPath, "issues.jsonl"), `${lines}\n`);
  return { id, beadsPath };
}

async function main(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "gitboard-beads-width-smoke-"));
  const db = createXtrmDatabase(join(fixtureRoot, "xtrm.sqlite"));
  const samples: Sample[] = [];
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  let runtime: BeadsWatcherRuntime<BeadsProject> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let materializer: Materializer | undefined;
  let commitHashReads = 0;
  let snapshotReads = 0;

  try {
    for (let sourceIndex = 0; sourceIndex < SOURCE_COUNT; sourceIndex += 1) writeFixture(fixtureRoot, sourceIndex);

    // Bind only loopback, ephemeral port. Never use gitboard.service or port 3030.
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ok", environment: "isolated-smoke" }),
    });
    if (server.port === 3030) throw new Error("smoke selected forbidden production port 3030");
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    if (!health.ok) throw new Error(`isolated health endpoint failed: ${health.status}`);

    const scanner = new ProjectScanner({ searchPath: fixtureRoot, maxDepth: 2 });
    const projects = await scanner.scanAll();
    if (projects.length !== SOURCE_COUNT) throw new Error(`fixture discovery found ${projects.length}, expected ${SOURCE_COUNT}`);

    materializer = new Materializer(db, undefined, {
      emitLog: (entry) => logs.push({ event: entry.event, data: entry.data }),
      bumpObservabilityEpoch: () => undefined,
    });
    for (const project of projects) {
      const sourceKey = `beads:${project.id}`;
      materializer.register(sourceKey, new BeadsAdapter({
        sourceKey,
        projectId: project.id,
        xtrmDb: db,
        readSnapshot: () => readBeadsIssuesFromJsonl(project.beadsPath),
      }));
    }

    const watcher = new BeadsWatcherRuntime<BeadsProject>({
      scanProjects: () => scanner.scanAll(),
      readSnapshot: async () => {
        snapshotReads += 1;
        throw new Error("unchanged trigger heartbeat read snapshot");
      },
      readCommitHash: async () => {
        commitHashReads += 1;
        return null;
      },
      publish: () => undefined,
      emitLog: (entry) => logs.push({ event: entry.event, data: entry.data }),
      triggerMaterializer: (project) => materializer?.trigger(`beads:${project.id}`),
    }, {
      activePollMs: EQUIVALENT_HEARTBEAT_MS,
      idlePollMs: EQUIVALENT_HEARTBEAT_MS,
      debounceMs: 10,
      coalesceMs: 10,
    });

    runtime = watcher;
    samples.push(memorySample("before-initial", db, materializer, 0, commitHashReads));
    watcher.start();
    await waitFor(() => {
      const rowCount = Number((db.query("SELECT COUNT(*) AS count FROM substrate_issues WHERE deleted_at IS NULL").get() as { count: number }).count);
      const successfulSources = Number((db.query("SELECT COUNT(*) AS count FROM materialization_state WHERE last_status = 'success'").get() as { count: number }).count);
      return rowCount === EXPECTED_TOTAL_ROWS && successfulSources === SOURCE_COUNT && materializer?.getSchedulerStats().active === 0 && materializer?.getSchedulerStats().pending === 0;
    }, 180_000, "initial 21-source materialization");

    const initialRuns = logs.filter((entry) => entry.event === "materializer.run").length;
    if (initialRuns !== SOURCE_COUNT) throw new Error(`initial materializer runs=${initialRuns}, expected ${SOURCE_COUNT}`);
    samples.push(memorySample("initial-complete", db, materializer, initialRuns, commitHashReads));

    for (let cycle = 1; cycle <= UNCHANGED_CYCLES; cycle += 1) {
      const targetReads = commitHashReads + SOURCE_COUNT;
      await waitFor(() => commitHashReads >= targetReads, 10_000, `unchanged heartbeat cycle ${cycle}`);
      // Allow any incorrectly scheduled coalesced work to surface before sampling.
      await sleep(COALESCE_MS + 100);
      const runs = logs.filter((entry) => entry.event === "materializer.run").length;
      if (runs !== initialRuns) throw new Error(`unchanged cycle ${cycle} added runs: ${runs - initialRuns}`);
      samples.push(memorySample(`unchanged-cycle-${cycle}`, db, materializer, runs, commitHashReads));
    }

    const initial = samples.find((sample) => sample.phase === "initial-complete");
    if (!initial) throw new Error("missing initial memory sample");
    const unchanged = samples.filter((sample) => sample.phase.startsWith("unchanged-cycle-"));
    if (unchanged.length !== UNCHANGED_CYCLES) throw new Error("missing unchanged-cycle samples");
    const peakUnchangedRss = Math.max(...unchanged.map((sample) => sample.rss_bytes));
    const peakUnchangedHeap = Math.max(...unchanged.map((sample) => sample.heap_used_bytes));
    if (peakUnchangedRss > initial.rss_bytes + RSS_HEADROOM_BYTES) throw new Error("RSS grew beyond smoke bound during unchanged cycles");
    if (peakUnchangedHeap > initial.heap_used_bytes + HEAP_HEADROOM_BYTES) throw new Error("heap grew beyond smoke bound during unchanged cycles");
    if (snapshotReads !== 0) throw new Error(`watcher read ${snapshotReads} snapshots on trigger path`);
    if (materializer.getSchedulerStats().maxActive > 2 || materializer.getSchedulerStats().maxPending > 8) throw new Error("scheduler bound exceeded");

    const logDir = import.meta.dir;
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "p0-beads-width-memory.log");
    writeFileSync(logPath, [
      `fixture_root=${fixtureRoot}`,
      `non_production_port=${server.port}`,
      `sources=${SOURCE_COUNT}`,
      `rows_per_source=${ROWS_PER_SOURCE}`,
      `expected_total_rows=${EXPECTED_TOTAL_ROWS}`,
      `unchanged_cycles=${UNCHANGED_CYCLES}`,
      ...samples.map((sample) => JSON.stringify(sample)),
    ].join("\n") + "\n");
    console.log(`beads width memory smoke passed; log=${logPath}; non_production_port=${server.port}`);
  } finally {
    runtime?.stop();
    server?.stop(true);
    db.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
