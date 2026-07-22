import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../src/state/database.ts";
import { Materializer, type MaterializerHooks, type MaterializerLogEntry } from "../src/materializer/materializer.ts";
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

function countRows(xtrmDb: Database, sourceKey: string): number {
  return (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = ?").get(sourceKey) as { c: number }).c;
}

function countDistinctEventIds(xtrmDb: Database, sourceKey: string): number {
  return (xtrmDb.query("SELECT COUNT(DISTINCT source_event_id) AS c FROM xtrm_forensic_events WHERE source_key = ?").get(sourceKey) as { c: number }).c;
}

async function waitFor(check: () => boolean, timeoutMs: number, failureLabel: string, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${failureLabel}`);
}

function createRunCapture() {
  const entries: MaterializerLogEntry[] = [];
  const hooks: MaterializerHooks = { emitLog: (entry) => entries.push(entry) };
  const runCount = (sourceKey: string): number =>
    entries.filter((entry) => entry.event === "materializer.run" && entry.data?.source_key === sourceKey).length;
  return { hooks, runCount };
}

function createForensicSourceDbWithPayload(dbPath: string, payloads: Array<string | null>): Database {
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
  payloads.forEach((payload, index) => {
    const i = index + 1;
    stmt.run(
      `job-${i}`, i, 1700000000000 + i, "xtrm.forensic.v1", "job", "job.step",
      "specialist", "executor", `p-${i}`, "clean", payload,
    );
  });
  return db;
}

function validPayload(i: number): string {
  return JSON.stringify({ schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i, severity: "info", event_family: "job", event_name: "job.step", event_version: 1, resource: {}, correlation: { job_id: `job-${i}` }, body: {}, redaction: { status: "clean" } });
}

function createLegacySourceDb(dbPath: string, rowCount: number): Database {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE specialist_jobs (job_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
  db.exec("CREATE TABLE specialist_events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, seq INTEGER, t TEXT, type TEXT, event_json TEXT)");
  const stmt = db.query("INSERT INTO specialist_events (job_id, seq, t, type, event_json) VALUES (?, ?, ?, ?, ?)");
  for (let i = 1; i <= rowCount; i++) {
    stmt.run(`job-${i}`, i, "2023-01-01T00:00:00Z", "job.completed", validPayload(i));
  }
  return db;
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

  it("legacy specialist_events fallback with batch limit and cursor (small)", async () => {
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

describe("observability adapter: adversarial bounded-continuation regression", () => {
  it("exact 500-row boundary terminates after at most one empty continuation (no silent loop)", async () => {
    const root = makeTempDir("obs-exact-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, FORENSIC_BATCH_SIZE);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const capture = createRunCapture();
    const materializer = new Materializer(xtrmDb, undefined, capture.hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    materializer.trigger("obs:repo-1");
    // Run 1 = full 500-row batch (hasMore=true), Run 2 = empty continuation (hasMore=false)
    await waitFor(() => capture.runCount("obs:repo-1") >= 2, 10000, "full batch + one empty continuation");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(FORENSIC_BATCH_SIZE);

    // Quiet period longer than COALESCE_MS: a third run would prove a loop; expect none.
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 400));
    expect(capture.runCount("obs:repo-1")).toBe(2);
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    expect(countDistinctEventIds(xtrmDb, "obs:repo-1")).toBe(FORENSIC_BATCH_SIZE);
    obsDb.close();
    xtrmDb.close();
  }, 20000);

  it("malformed-only full batch advances committed cursor to boundary and terminates after one empty continuation", async () => {
    const root = makeTempDir("obs-malformed-batch-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const payloads = Array.from({ length: FORENSIC_BATCH_SIZE }, () => "{not-json");
    const obsDb = createForensicSourceDbWithPayload(obsDbPath, payloads);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const capture = createRunCapture();
    const materializer = new Materializer(xtrmDb, undefined, capture.hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    materializer.trigger("obs:repo-1");
    // Cursor must advance past unparseable rows (no stall), then one empty continuation terminates.
    await waitFor(
      () => getCursor(xtrmDb, "obs:repo-1").forensic_rowid >= FORENSIC_BATCH_SIZE && capture.runCount("obs:repo-1") >= 2,
      10000,
      "cursor reaches boundary and empty continuation runs",
    );
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(0); // nothing materializable
    const sentinels = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' AND source_event_id = 'forensic:undefined'").get() as { c: number }).c;
    expect(sentinels).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 400));
    expect(capture.runCount("obs:repo-1")).toBe(2);
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    obsDb.close();
    xtrmDb.close();
  }, 20000);

  it("mixed malformed payload rows are skipped but still advance the committed cursor (no stall, idempotent tail)", async () => {
    const root = makeTempDir("obs-malformed-mixed-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDbWithPayload(obsDbPath, [
      validPayload(1),
      "{not-json",
      null,
      '"scalar"',
      validPayload(5),
    ]);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    // Cursor commits past ALL five rowids even though only two rows parse.
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(5);
    const events = xtrmDb.query("SELECT source_event_id FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' ORDER BY source_event_id").all() as Array<{ source_event_id: string }>;
    expect(events.map((e) => e.source_event_id)).toEqual(["forensic:1", "forensic:5"]);
    const sentinels = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' AND source_event_id = 'forensic:undefined'").get() as { c: number }).c;
    expect(sentinels).toBe(0);

    // Idempotent tail: re-run does not regress cursor or duplicate rows.
    await materializer.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(5);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(2);
    obsDb.close();
    xtrmDb.close();
  });

  it("legacy specialist_events drain across >2 batches automatically with exact iteration count", async () => {
    const root = makeTempDir("obs-legacy-drain-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE * 2 + 11;
    const obsDb = createLegacySourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    let iterations = 0;
    while (iterations < 20) {
      await materializer.runOnce("obs:repo-1");
      iterations++;
      if (getCursor(xtrmDb, "obs:repo-1").event_rowid >= totalRows) break;
    }

    expect(iterations).toBe(3); // 2 full batches + 1 partial (11 rows), no extra empty pass needed
    expect(getCursor(xtrmDb, "obs:repo-1").event_rowid).toBe(totalRows);
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(0); // legacy path must not touch forensic cursor
    expect(countDistinctEventIds(xtrmDb, "obs:repo-1")).toBe(totalRows);
    const first = xtrmDb.query("SELECT source_event_id FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1' ORDER BY CAST(SUBSTR(source_event_id, 8) AS INTEGER) ASC LIMIT 1").all() as Array<{ source_event_id: string }>;
    expect(first[0]?.source_event_id).toBe("legacy:1");

    // Tail no-op: one more pass changes nothing.
    await materializer.runOnce("obs:repo-1");
    expect(getCursor(xtrmDb, "obs:repo-1").event_rowid).toBe(totalRows);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(totalRows);
    obsDb.close();
    xtrmDb.close();
  });

  it("queue coalescing: burst of 5 triggers yields exactly one run, no duplicates, no starvation after idle", async () => {
    const root = makeTempDir("obs-coalesce-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createForensicSourceDb(obsDbPath, 10);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const capture = createRunCapture();
    const materializer = new Materializer(xtrmDb, undefined, capture.hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    for (let i = 0; i < 5; i++) materializer.trigger("obs:repo-1");
    await waitFor(() => capture.runCount("obs:repo-1") >= 1, 10000, "coalesced run executes");
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 400));

    expect(capture.runCount("obs:repo-1")).toBe(1); // 5 triggers coalesced into a single run
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(10);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(10);
    expect(countDistinctEventIds(xtrmDb, "obs:repo-1")).toBe(10);

    // No starvation: a fresh trigger after idle is still serviced.
    materializer.trigger("obs:repo-1");
    await waitFor(() => capture.runCount("obs:repo-1") === 2, 10000, "post-idle trigger serviced");
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(10);
    expect(countDistinctEventIds(xtrmDb, "obs:repo-1")).toBe(10); // empty re-run duplicates nothing
    obsDb.close();
    xtrmDb.close();
  }, 20000);

  it("continuation under concurrent burst: bounded runs, no duplicate writes, stable after quiet", async () => {
    const root = makeTempDir("obs-burst-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const totalRows = FORENSIC_BATCH_SIZE + 5;
    const obsDb = createForensicSourceDb(obsDbPath, totalRows);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const capture = createRunCapture();
    const materializer = new Materializer(xtrmDb, undefined, capture.hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    materializer.trigger("obs:repo-1");
    await waitFor(() => getCursor(xtrmDb, "obs:repo-1").forensic_rowid >= FORENSIC_BATCH_SIZE, 10000, "first batch committed");

    // Burst while the hasMore continuation timer/run may be in flight.
    materializer.trigger("obs:repo-1");
    materializer.trigger("obs:repo-1");
    materializer.trigger("obs:repo-1");

    await waitFor(() => getCursor(xtrmDb, "obs:repo-1").forensic_rowid >= totalRows, 10000, "full drain after burst");
    const runsAfterDrain = capture.runCount("obs:repo-1");
    expect(runsAfterDrain).toBeGreaterThanOrEqual(2); // initial + continuation
    expect(runsAfterDrain).toBeLessThanOrEqual(3); // burst may add at most one coalesced extra run
    expect(countDistinctEventIds(xtrmDb, "obs:repo-1")).toBe(totalRows); // no duplicate writes

    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 400));
    expect(capture.runCount("obs:repo-1")).toBe(runsAfterDrain); // stable: no runaway re-scheduling
    expect(getCursor(xtrmDb, "obs:repo-1").forensic_rowid).toBe(totalRows);
    expect(countRows(xtrmDb, "obs:repo-1")).toBe(totalRows);
    obsDb.close();
    xtrmDb.close();
  }, 20000);
});
