import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../../src/state/database.ts";
import { COALESCE_MS } from "../../src/materializer/queue.ts";
import { Materializer, type MaterializerLogEntry, type MaterializerRealtimePublisher } from "../../src/materializer/materializer.ts";
import { createObservabilityAdapter } from "../../src/materializer/observability-adapter.ts";
import type { MaterializerAdapter } from "../../src/materializer/types.ts";

afterEach(() => {
  vi.useRealTimers();
});

async function flushMaterializer(materializer: Materializer, isComplete: () => boolean): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    if (isComplete() && materializer.getSchedulerStats().active === 0 && materializer.getSchedulerStats().pending === 0) return;
    vi.advanceTimersByTime(COALESCE_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
  throw new Error("materializer did not drain deterministically");
}

afterEach(async () => {
  await rm(join(process.cwd(), ".tmp-materializer"), { recursive: true, force: true });
});

async function createDb() {
  const dir = join(process.cwd(), ".tmp-materializer");
  await mkdir(dir, { recursive: true });
  return createXtrmDatabase(join(dir, "xtrm.sqlite"));
}

class CollectingPublisher implements MaterializerRealtimePublisher {
  readonly events: Array<{ channel: string; event: string; data: Record<string, unknown>; version: string }> = [];

  publish(channel: string, event: string, data: Record<string, unknown>, version: string): void {
    this.events.push({ channel, event, data, version });
  }
}

function createObservabilityDb(): Database {
  const dir = join(process.cwd(), ".tmp-materializer");
  const db = new Database(join(dir, "observability.sqlite"), { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS specialist_jobs (
      job_id TEXT PRIMARY KEY,
      specialist TEXT NOT NULL,
      worktree_column TEXT,
      bead_id TEXT,
      node_id TEXT,
      status TEXT NOT NULL,
      status_json TEXT NOT NULL DEFAULT '{}',
      updated_at_ms INTEGER NOT NULL,
      last_output TEXT,
      startup_payload_json TEXT,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT NOT NULL DEFAULT 'prep',
      chain_root_job_id TEXT,
      chain_root_bead_id TEXT
    );
    CREATE TABLE IF NOT EXISTS specialist_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      seq INTEGER,
      specialist TEXT,
      bead_id TEXT,
      t INTEGER,
      type TEXT,
      event_json TEXT
    );
  `);
  return db;
}

function createAdapter(batches: Array<Array<{ issue_id: string; title: string }>>): MaterializerAdapter {
  let cursor = 0;
  return {
    async cursor() {
      return { cursor: 0 };
    },
    async changesSince(input) {
      void input;
      const rows = batches[cursor] ?? [];
      cursor += 1;
      return {
        cursor: { cursor },
        rows: rows.map((row) => ({ repo_slug: "repo/a", issue_id: row.issue_id, title: row.title, state: "open" })),
      };
    },
    async snapshot() {
      const rows = batches.flat().map((row) => ({ repo_slug: "repo/a", issue_id: row.issue_id, title: row.title, state: "open" }));
      return { rows };
    },
    write(db, snapshot) {
      const stmt = db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state) VALUES (?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET title=excluded.title, state=excluded.state");
      for (const row of snapshot.rows) stmt.run(row.repo_slug, row.issue_id, row.title ?? null, row.state);
    },
  };
}

describe("materializer", () => {
  it("coalesces same source triggers and isolates source failures", async () => {
    vi.useFakeTimers();
    const db = await createDb();
    const publisher = new CollectingPublisher();
    const errors: MaterializerLogEntry[] = [];
    const materializer = new Materializer(db, publisher, {
      emitLog: (entry) => { if (entry.event === "materializer.error") errors.push(entry); },
    });
    const adapterA = createAdapter([[{ issue_id: "1", title: "one" }], [{ issue_id: "1", title: "one-updated" }]]);
    let shouldFail = true;
    const adapterB: MaterializerAdapter = {
      async cursor() {
        return { cursor: 0 };
      },
      async changesSince() {
        if (shouldFail) throw new Error("boom");
        return { cursor: { cursor: 1 }, rows: [] };
      },
      async snapshot() {
        return { rows: [] };
      },
      write() {},
    };

    materializer.register("a", adapterA);
    materializer.register("b", adapterB);
    materializer.trigger("a");
    materializer.trigger("a");
    materializer.trigger("b");
    await flushMaterializer(materializer, () => errors.length === 1 && publisher.events.length === 1);

    expect(db.query("SELECT title FROM substrate_issues WHERE repo_slug = 'repo/a' AND issue_id = '1'").get() as { title: string }).toEqual({ title: "one" });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'b'").get()).toBeFalsy();
    expect(publisher.events).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { data?: { source_key?: string; error?: string } }).data).toEqual({ source_key: "b", error: "boom" });

    shouldFail = false;
    materializer.trigger("b");
    await flushMaterializer(materializer, () => errors.length === 1 && publisher.events.length === 2);
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'b'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    expect(publisher.events).toHaveLength(2);
    db.close();
  });

  it("drains 21 large sources with bounded concurrency and coalescing", async () => {
    vi.useFakeTimers();
    const db = await createDb();
    const materializer = new Materializer(db);
    let activeRuns = 0;
    let peakActiveRuns = 0;
    let completedRuns = 0;
    let materializedRows = 0;
    const rowsPerSource = 500;

    for (let sourceIndex = 0; sourceIndex < 21; sourceIndex += 1) {
      const sourceRows = Array.from({ length: rowsPerSource }, (_, rowIndex) => ({
        issue_id: `${sourceIndex}-${rowIndex}`,
        title: `issue-${sourceIndex}-${rowIndex}`,
      }));
      const sourceKey = `beads:large-${sourceIndex}`;
      materializer.register(sourceKey, {
        async cursor() { return { cursor: 0 }; },
        async changesSince() {
          activeRuns += 1;
          peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
          await Promise.resolve();
          activeRuns -= 1;
          completedRuns += 1;
          materializedRows += sourceRows.length;
          return { cursor: { cursor: 1 }, rows: sourceRows };
        },
        async snapshot() { return { rows: sourceRows }; },
        write() {},
      });
      materializer.trigger(sourceKey);
      materializer.trigger(sourceKey);
    }

    await flushMaterializer(materializer, () => completedRuns === 21);
    const scheduler = materializer.getSchedulerStats();

    expect(completedRuns).toBe(21);
    expect(materializedRows).toBeGreaterThanOrEqual(10_000);
    expect(peakActiveRuns).toBeLessThanOrEqual(2);
    expect(scheduler.maxActive).toBeLessThanOrEqual(2);
    expect(scheduler.maxPending).toBeLessThanOrEqual(8);
    expect(scheduler.pending).toBe(0);
    expect(scheduler.active).toBe(0);
    db.close();
  });

  it("rolls back writes when cursor advance crashes, then re-applies", async () => {
    const db = await createDb();
    const materializer = new Materializer(db, undefined, {
      afterWritesBeforeCursorAdvance: () => {
        throw new Error("crash");
      },
    });
    const adapter = createAdapter([[{ issue_id: "1", title: "one" }]]);
    materializer.register("a", adapter);

    await expect(materializer.runOnce("a")).rejects.toThrow("crash");
    expect(db.query("SELECT count(*) AS count FROM substrate_issues").get() as { count: number }).toEqual({ count: 0 });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: null }).toEqual({ cursor: null });

    const recovery = new Materializer(db);
    recovery.register("a", createAdapter([[{ issue_id: "1", title: "one" }]]));
    await recovery.runOnce("a");
    expect(db.query("SELECT title FROM substrate_issues WHERE repo_slug = 'repo/a' AND issue_id = '1'").get() as { title: string }).toEqual({ title: "one" });
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    db.close();
  });

  it("applies 100 rows in one batch with one hint", async () => {
    const db = await createDb();
    const publisher = new CollectingPublisher();
    const runs: MaterializerLogEntry[] = [];
    const materializer = new Materializer(db, publisher, {
      emitLog: (entry) => { if (entry.event === "materializer.run") runs.push(entry); },
    });
    const adapter = createAdapter([Array.from({ length: 100 }, (_, i) => ({ issue_id: String(i), title: `t${i}` }))]);
    materializer.register("a", adapter);

    await materializer.runOnce("a");
    const rows = db.query("SELECT issue_id, title FROM substrate_issues WHERE repo_slug = 'repo/a' ORDER BY issue_id").all() as Array<{ issue_id: string; title: string }>;
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ issue_id: "0", title: "t0" });
    expect(rows[99]).toEqual({ issue_id: "99", title: "t99" });
    expect(publisher.events).toHaveLength(1);
    expect(db.query("SELECT json_extract(cursor, '$.cursor') AS cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: number }).toEqual({ cursor: 1 });
    expect(runs).toHaveLength(1);
    expect((runs[0] as { data?: { source_key?: string; duration_ms?: number; rows_written?: number; dependencies_written?: number } }).data).toMatchObject({ source_key: "a", rows_written: 100, dependencies_written: 0 });
    expect(((runs[0] as { data?: { duration_ms?: number } }).data?.duration_ms ?? -1)).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it("publishes bead sync hints with project ids for dashboard invalidation", async () => {
    const db = await createDb();
    const publisher = new CollectingPublisher();
    const materializer = new Materializer(db, publisher);
    const adapter = createAdapter([[{ issue_id: "1", title: "one" }]]);
    materializer.register("beads:repo/a", adapter);

    await materializer.runOnce("beads:repo/a");

    expect(publisher.events).toHaveLength(2);
    expect(publisher.events[0]).toMatchObject({
      channel: "substrate:changes",
      event: "substrate:sync_hint",
      data: {
        source_key: "beads:repo/a",
        projectId: "repo/a",
        project_id: "repo/a",
      },
    });
    db.close();
  });

  it("returns null cursor and warns on corrupt materialization cursor row", async () => {
    const db = await createDb();
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("a", "{not-json");
    const warnings: MaterializerLogEntry[] = [];
    const materializer = new Materializer(db, undefined, {
      emitLog: (entry) => { if (entry.event === "materializer.cursor.invalid") warnings.push(entry); },
    });
    materializer.register("a", createAdapter([[{ issue_id: "1", title: "one" }]]));
    await materializer.runOnce("a");

    expect(warnings).toHaveLength(1);
    const warnData = (warnings[0] as { data?: Record<string, unknown> }).data;
    expect(warnData).toEqual({ source_key: "a", cursor_bytes: 9, cursor_valid_json: false, cursor_redacted: true });
    expect(JSON.stringify(warnData)).not.toContain("{not-json");
    expect(db.query("SELECT cursor FROM materialization_state WHERE source_key = 'a'").get() as { cursor: string }).toEqual({ cursor: '{"cursor":1}' });
    db.close();
  });

  it("tracks observability cursor pair and re-reads touched jobs from events", async () => {
    const xtrmDb = await createDb();
    const obsDb = createObservabilityDb();
    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, updated_at_ms, last_output) VALUES (?, ?, ?, ?, ?)").run("job-1", "sp1", "running", 500, null);
    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, updated_at_ms, last_output) VALUES (?, ?, ?, ?, ?)").run("job-2", "sp2", "done", 2000, null);
    obsDb.query("INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run("job-1", 1, "sp1", null, 1, "turn", "{}");

    const adapter = createObservabilityAdapter(join(process.cwd(), ".tmp-materializer", "observability.sqlite"), "repo/a");
    const first = await adapter.changesSince({ updated_at_ms: 0, event_rowid: 0 });
    expect(first.cursor).toEqual({ updated_at_ms: 2000, event_rowid: 1, forensic_rowid: 0, job_id: "job-2" });
    expect(first.rows.map((row) => row.job_id)).toEqual(["job-1", "job-2"]);

    obsDb.query("INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run("job-1", 2, "sp1", null, 2, "turn", "{\"x\":1}");
    const second = await adapter.changesSince(first.cursor);
    expect(second.cursor).toEqual({ updated_at_ms: 2000, event_rowid: 2, forensic_rowid: 0, job_id: "job-2" });
    expect(second.rows.map((row) => row.job_id).sort()).toEqual(["job-1"]);
    obsDb.close();
    xtrmDb.close();
  });
});
