import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../src/state/database.ts";
import { Materializer } from "../src/materializer/materializer.ts";
import { COALESCE_MS, SourceQueue } from "../src/materializer/queue.ts";
import { createObservabilityAdapter, FORENSIC_BATCH_SIZE } from "../src/materializer/observability-adapter.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createForensicSourceDb(dbPath: string, rowCount: number): Database {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE specialist_jobs (
    job_id TEXT, bead_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT,
    chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER
  )`);
  db.exec(`CREATE TABLE specialist_forensic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT, seq INTEGER, t INTEGER, schema_version TEXT, event_family TEXT,
    event_name TEXT, participant_kind TEXT, participant_role TEXT, participant_id TEXT,
    redaction_status TEXT, event_json TEXT
  )`);
  const stmt = db.query(
    "INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 1; i <= rowCount; i++) {
    stmt.run(
      `job-${i}`, i, 1700000000000 + i, "xtrm.forensic.v1", "job", "job.step",
      "specialist", "executor", `p-${i}`, "clean",
      JSON.stringify({ schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i, severity: "info", event_family: "job", event_name: "job.step", event_version: 1, resource: {}, correlation: { job_id: `job-${i}` }, body: {}, redaction: { status: "clean" } }),
    );
  }
  return db;
}

function getCursor(xtrmDb: Database, sourceKey: string): { updated_at_ms: number; event_rowid: number; forensic_rowid: number } {
  const row = xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(sourceKey) as { cursor: string } | undefined;
  return row ? JSON.parse(row.cursor) : { updated_at_ms: 0, event_rowid: 0, forensic_rowid: 0 };
}

describe("observability adapter: forensic backfill, cursor, and bounded continuation", () => {
  it("fixes bare-rowid aliasing: id INTEGER PRIMARY KEY yields unique forensic:N ids and advances cursor", async () => {
    const root = makeTempDir("obs-rowid-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, 3);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    const events = xtrmDb.query("SELECT source_event_id FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' ORDER BY source_event_id").all() as Array<{ source_event_id: string }>;
    expect(events.map((e) => e.source_event_id)).toEqual(["forensic:1", "forensic:2", "forensic:3"]);
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(3);
    obsDb.close();
  });

  it("bounds first call to FORENSIC_BATCH_SIZE and reports hasMore via cursor position", async () => {
    const root = makeTempDir("obs-bound-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE * 2 + 10;
    const obsDb = createForensicSourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    const count = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(count).toBe(FORENSIC_BATCH_SIZE);
    obsDb.close();
  });

  it("drains >2 batches to source max without another fs event", async () => {
    const root = makeTempDir("obs-drain-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE * 3 + 7;
    const obsDb = createForensicSourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    let iterations = 0;
    while (iterations < 20) {
      await materializer.runOnce("obs:repo-1");
      iterations++;
      if (getCursor(xtrmDb, "obs:repo-1").forensic_rowid >= totalRows) break;
    }

    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(totalRows);
    const count = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(count).toBe(totalRows);
    const distinct = (xtrmDb.query("SELECT COUNT(DISTINCT source_event_id) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(distinct).toBe(totalRows);
    expect(iterations).toBe(4); // 3 full batches + 1 partial
    obsDb.close();
  });

  it("second trigger with no new rows is constant/empty (no re-read)", async () => {
    const root = makeTempDir("obs-noop-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, 5);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(5);

    await materializer.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(5);
    const count = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(count).toBe(5);
    obsDb.close();
  });

  it("restart resumes from last committed cursor (new Materializer instance)", async () => {
    const root = makeTempDir("obs-restart-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE + 5;
    const obsDb = createForensicSourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const m1 = new Materializer(xtrmDb);
    m1.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await m1.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);

    // Simulate restart
    const m2 = new Materializer(xtrmDb);
    m2.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await m2.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(totalRows);

    const count = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(count).toBe(totalRows);
    obsDb.close();
  });

  it("transaction rollback does not advance cursor", async () => {
    const root = makeTempDir("obs-rollback-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, 5);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    // Corrupt xtrm_forensic_events to force write failure
    xtrmDb.exec("DROP TABLE xtrm_forensic_events");

    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    await expect(materializer.runOnce("obs:repo-1")).rejects.toThrow();

    // Cursor must not advance (rollback)
    const state = xtrmDb.query("SELECT cursor, last_status FROM materialization_state WHERE source_key = 'obs:repo-1'").get() as { cursor: string | null; last_status: string } | undefined;
    if (state?.cursor) {
      expect(JSON.parse(state.cursor).forensic_rowid).toBe(0);
    }
    expect(state?.last_status).toBe("error");
    obsDb.close();
  });

  it("source-scoped forensic:undefined cleanup removes only matching source_key rows", async () => {
    const root = makeTempDir("obs-sentinel-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, 2);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    // Pre-seed malformed rows for TWO sources
    const insertMalformed = xtrmDb.query("INSERT INTO xtrm_forensic_events (source_key, source_event_id, repo_slug, schema_version, resource_json, correlation_json, body_json, redaction_json, envelope_json) VALUES (?, 'forensic:undefined', ?, 'xtrm.forensic.v1', '{}', '{}', '{}', '{}', '{}')");
    insertMalformed.run("obs:repo-1", "repo-1");
    insertMalformed.run("obs:repo-2", "repo-2");
    xtrmDb.query("INSERT INTO xtrm_evidence_refs (source_key, repo_slug, evidence_id, evidence_kind, event_source_id, ref_json) VALUES (?, ?, 'bad-ref', 'commit', 'forensic:undefined', '{}')").run("obs:repo-1", "repo-1");

    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    // repo-1 malformed removed
    const r1 = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' AND source_event_id = 'forensic:undefined'").get() as { c: number }).c;
    expect(r1).toBe(0);
    // repo-2 malformed preserved (source-scoped)
    const r2 = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-2' AND source_event_id = 'forensic:undefined'").get() as { c: number }).c;
    expect(r2).toBe(1);
    // evidence ref cleaned
    const refs = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_evidence_refs WHERE source_key = 'obs:repo-1' AND event_source_id = 'forensic:undefined'").get() as { c: number }).c;
    expect(refs).toBe(0);
    obsDb.close();
  });

  it("hasMore continuation re-enters via SourceQueue (non-recursive, coalesced)", async () => {
    const root = makeTempDir("obs-queue-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE * 2 + 3;
    const obsDb = createForensicSourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    // Trigger via queue (simulates watcher event); wait for coalesce + processing
    materializer.trigger("obs:repo-1");
    await new Promise((r) => setTimeout(r, COALESCE_MS + 300));
    // First batch processed, hasMore re-enqueued automatically
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBeGreaterThanOrEqual(FORENSIC_BATCH_SIZE);

    // Wait for continuation drain (each batch needs COALESCE_MS)
    await new Promise((r) => setTimeout(r, COALESCE_MS * 3 + 500));
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(totalRows);

    const count = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(count).toBe(totalRows);
    obsDb.close();
  }, 15000);

  it("fairness: two sources both drain without starvation", async () => {
    const root = makeTempDir("obs-fair-");
    const obsDbPathA = join(root, "obs-a.db");
    const obsDbPathB = join(root, "obs-b.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDbA = createForensicSourceDb(obsDbPathA, FORENSIC_BATCH_SIZE + 2);
    const obsDbB = createForensicSourceDb(obsDbPathB, FORENSIC_BATCH_SIZE + 2);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-a", createObservabilityAdapter(obsDbPathA, "repo-a"));
    materializer.register("obs:repo-b", createObservabilityAdapter(obsDbPathB, "repo-b"));

    materializer.trigger("obs:repo-a");
    materializer.trigger("obs:repo-b");
    await new Promise((r) => setTimeout(r, COALESCE_MS + 300));

    // Both sources got first batch (fair scheduling)
    expect(getCursor(xtrmDb, "obs:repo-a").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    expect(getCursor(xtrmDb, "obs:repo-b").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);

    // Wait for continuation drain
    await new Promise((r) => setTimeout(r, COALESCE_MS * 2 + 500));
    expect(getCursor(xtrmDb, "obs:repo-a").forensic_rowid).toBe(FORENSIC_BATCH_SIZE + 2);
    expect(getCursor(xtrmDb, "obs:repo-b").forensic_rowid).toBe(FORENSIC_BATCH_SIZE + 2);
    obsDbA.close();
    obsDbB.close();
  }, 15000);

  it("legacy specialist_events fallback with batch limit and cursor", async () => {
    const root = makeTempDir("obs-legacy-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = new Database(obsDbPath);
    obsDb.exec("CREATE TABLE specialist_jobs (job_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
    obsDb.exec("CREATE TABLE specialist_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, seq INTEGER, t TEXT, type TEXT, event_json TEXT)");
    for (let i = 1; i <= 3; i++) {
      obsDb.query("INSERT INTO specialist_events (job_id, seq, t, type, event_json) VALUES (?, ?, ?, ?, ?)")
        .run(`job-${i}`, i, "2023-01-01T00:00:00Z", "job.completed", JSON.stringify({ schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i, severity: "info", event_family: "job", event_name: "job.completed", event_version: 1, resource: {}, correlation: { job_id: `job-${i}` }, body: {}, redaction: { status: "clean" } }));
    }

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    const events = xtrmDb.query("SELECT source_event_id FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' ORDER BY source_event_id").all() as Array<{ source_event_id: string }>;
    expect(events.map((e) => e.source_event_id)).toEqual(["legacy:1", "legacy:2", "legacy:3"]);
    expect(getCursor(xtrmDb, "obs:repo-1").event_rowid).toBe(3);
    obsDb.close();
  });
});
