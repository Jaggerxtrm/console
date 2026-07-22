import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../src/state/database.ts";
import { Materializer, type MaterializerHooks, type MaterializerLogEntry } from "../src/materializer/materializer.ts";
import {
  createObservabilityAdapter,
  EVIDENCE_REFS_PER_EVENT_CAP,
  EVIDENCE_REFS_PER_RUN_CAP,
  EVENT_PAYLOAD_MAX_BYTES,
  FORENSIC_BATCH_SIZE,
  JOB_BATCH_SIZE,
  JOB_ID_MAX_LEN,
  LAST_OUTPUT_MAX_BYTES,
  TOKEN_TRAJECTORY_MAX_BYTES,
} from "../src/materializer/observability-adapter.ts";

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

type SourceOptions = { jobs?: number; sameTimestamp?: boolean; metrics?: boolean };

function createSourceDb(dbPath: string, opts: SourceOptions = {}): Database {
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
  if (opts.metrics) {
    db.exec(`CREATE TABLE specialist_job_metrics (
      job_id TEXT, total_turns INTEGER, total_tools INTEGER, model TEXT, token_trajectory_json TEXT
    )`);
  }
  if (opts.jobs && opts.jobs > 0) {
    const stmt = db.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    const ts = opts.sameTimestamp ? 1700000000000 : 0;
    for (let i = 1; i <= opts.jobs; i++) {
      const id = `job-${String(i).padStart(6, "0")}`;
      stmt.run(id, "executor", "done", null, opts.sameTimestamp ? ts : 1700000000000 + i);
    }
  }
  return db;
}

function insertEvent(db: Database, jobId: string, payload: string | null, rowid = 1): void {
  db.query(
    "INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(jobId, rowid, 1700000000000 + rowid, "xtrm.forensic.v1", "job", "job.step", "specialist", "executor", `p-${rowid}`, "clean", payload);
}

function validPayload(i: number, body: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i, severity: "info", event_family: "job", event_name: "job.step", event_version: 1, resource: {}, correlation: { job_id: `job-${i}` }, body, redaction: { status: "clean" } });
}

const ZERO_CURSOR = { updated_at_ms: 0, job_id: "", event_rowid: 0, forensic_rowid: 0 };

describe("observability adapter: bounded job cardinality, byte caps, evidence caps, cursor sanitization", () => {
  it("pages >2 job batches with equal timestamps via stable tuple without dropping rows", async () => {
    const root = makeTempDir("obs-jobs-");
    const obsDbPath = join(root, "obs.db");
    const total = JOB_BATCH_SIZE * 2 + 37;
    const obsDb = createSourceDb(obsDbPath, { jobs: total, sameTimestamp: true });
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const seen = new Set<string>();
    let cursor: unknown = ZERO_CURSOR;
    let batches = 0;
    let hasMore = true;
    while (hasMore && batches < 20) {
      const delta = await adapter.changesSince(cursor);
      expect(delta.rows.length).toBeLessThanOrEqual(JOB_BATCH_SIZE);
      for (const row of delta.rows) seen.add(row.job_id);
      cursor = delta.cursor;
      hasMore = Boolean(delta.hasMore);
      batches += 1;
    }
    expect(batches).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBe(total);
    obsDb.close();
  });

  it("dual backlog: job and event streams both advance per run and fully drain without starvation", async () => {
    const root = makeTempDir("obs-dual-");
    const obsDbPath = join(root, "obs.db");
    const jobTotal = JOB_BATCH_SIZE + 5;
    const obsDb = createSourceDb(obsDbPath, { jobs: jobTotal });
    const eventTotal = FORENSIC_BATCH_SIZE + 5;
    for (let i = 1; i <= eventTotal; i++) insertEvent(obsDb, `job-${String(i).padStart(6, "0")}`, validPayload(i), i);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const first = await adapter.changesSince(ZERO_CURSOR);
    // both streams bounded per run and both signal more work
    expect(first.rows.length).toBeLessThanOrEqual(JOB_BATCH_SIZE);
    expect(first.forensicEvents.length).toBeLessThanOrEqual(FORENSIC_BATCH_SIZE);
    expect(first.hasMore).toBe(true);
    expect((first.cursor as { forensic_rowid: number }).forensic_rowid).toBe(FORENSIC_BATCH_SIZE);
    expect((first.cursor as { updated_at_ms: number }).updated_at_ms).toBeGreaterThan(0);

    const seenJobs = new Set<string>(first.rows.map((r) => r.job_id));
    let cursor: unknown = first.cursor;
    let hasMore = Boolean(first.hasMore);
    let guard = 0;
    while (hasMore && guard < 50) {
      const delta = await adapter.changesSince(cursor);
      for (const row of delta.rows) seenJobs.add(row.job_id);
      cursor = delta.cursor;
      hasMore = Boolean(delta.hasMore);
      guard += 1;
    }
    // no starvation: every job and every event fully drained
    expect(seenJobs.size).toBe(jobTotal);
    expect((cursor as { forensic_rowid: number }).forensic_rowid).toBe(eventTotal);
    obsDb.close();
  });

  it("does not materialize oversized last_output into JS; emits bounded marker", async () => {
    const root = makeTempDir("obs-lo-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    const huge = "x".repeat(LAST_OUTPUT_MAX_BYTES + 1024);
    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)").run("job-big", "executor", "done", huge, 1700000000001);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const row = delta.rows.find((r) => r.job_id === "job-big");
    expect(row).toBeDefined();
    expect(row!.last_output).not.toBe(huge);
    expect(row!.last_output!.length).toBeLessThan(256);
    expect(row!.last_output).toContain("oversized:last_output");
    obsDb.close();
  });

  it("does not materialize oversized token_trajectory_json; tokens zero and usage_source flagged", async () => {
    const root = makeTempDir("obs-tt-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath, { metrics: true });
    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)").run("job-tt", "executor", "done", null, 1700000000001);
    const hugeTrajectory = "[" + "x".repeat(TOKEN_TRAJECTORY_MAX_BYTES + 1024) + "]";
    obsDb.query("INSERT INTO specialist_job_metrics (job_id, total_turns, total_tools, model, token_trajectory_json) VALUES (?, ?, ?, ?, ?)").run("job-tt", 3, 4, "m", hugeTrajectory);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const row = delta.rows.find((r) => r.job_id === "job-tt");
    expect(row).toBeDefined();
    expect(row!.token_input).toBe(0);
    expect(row!.usage_source).toBe("specialist_job_metrics:oversized");
    obsDb.close();
  });

  it("does not heap-load oversized event_json; emits bounded oversized marker and advances cursor", async () => {
    const root = makeTempDir("obs-ev-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    const huge = JSON.stringify({ schema_version: "xtrm.forensic.v1", pad: "y".repeat(EVENT_PAYLOAD_MAX_BYTES + 4096) });
    insertEvent(obsDb, "job-1", huge, 1);
    insertEvent(obsDb, "job-2", validPayload(2), 2);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const marker = delta.forensicEvents.find((e) => e.source_event_id === "forensic:1");
    expect(marker).toBeDefined();
    expect(marker!.event_name).toBe("observability.payload.oversized");
    expect(marker!.envelope_json.length).toBeLessThan(1024);
    expect(marker!.envelope_json).not.toContain("yyyy");
    // normal row still materializes
    expect(delta.forensicEvents.some((e) => e.source_event_id === "forensic:2")).toBe(true);
    // cursor advances past the oversized row
    expect((delta.cursor as { forensic_rowid: number }).forensic_rowid).toBe(2);
    obsDb.close();
  });

  it("caps evidence refs per event and per run deterministically", async () => {
    const root = makeTempDir("obs-ref-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    const hugeRefs = Array.from({ length: EVIDENCE_REFS_PER_EVENT_CAP * 4 }, (_, i) => ({ evidence_kind: "file", id: `ref-${i}` }));
    insertEvent(obsDb, "job-1", validPayload(1, { evidence_refs: hugeRefs }), 1);
    insertEvent(obsDb, "job-2", validPayload(2, { evidence_refs: hugeRefs }), 2);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const perEvent = delta.evidenceRefs.filter((r) => r.event_source_id === "forensic:1").length;
    expect(perEvent).toBe(EVIDENCE_REFS_PER_EVENT_CAP);
    expect(delta.evidenceRefs.length).toBeLessThanOrEqual(EVIDENCE_REFS_PER_RUN_CAP);
    obsDb.close();
  });

  it("enforces the per-run evidence cap across many events", async () => {
    const root = makeTempDir("obs-refrun-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    const refsPerEvent = Array.from({ length: EVIDENCE_REFS_PER_EVENT_CAP }, (_, i) => ({ evidence_kind: "file", id: `ref-${i}` }));
    const eventCount = Math.ceil(EVIDENCE_REFS_PER_RUN_CAP / EVIDENCE_REFS_PER_EVENT_CAP) + 3;
    for (let i = 1; i <= eventCount; i++) insertEvent(obsDb, `job-${i}`, validPayload(i, { evidence_refs: refsPerEvent }), i);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    expect(delta.evidenceRefs.length).toBe(EVIDENCE_REFS_PER_RUN_CAP);
    obsDb.close();
  });

  it.each([
    ["negative", { ...ZERO_CURSOR, forensic_rowid: -5 }],
    ["fractional", { ...ZERO_CURSOR, forensic_rowid: 2.9 }],
    ["string", { ...ZERO_CURSOR, forensic_rowid: "3" }],
    ["NaN", { ...ZERO_CURSOR, forensic_rowid: Number.NaN }],
    ["Infinity", { ...ZERO_CURSOR, forensic_rowid: Number.POSITIVE_INFINITY }],
    ["unsafe", { ...ZERO_CURSOR, forensic_rowid: Number.MAX_SAFE_INTEGER + 100 }],
    ["extreme-ahead", { ...ZERO_CURSOR, forensic_rowid: 1e15 }],
  ])("sanitizes %s cursor without throwing, spin, or data loss", async (_label, badCursor) => {
    const root = makeTempDir("obs-cur-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertEvent(obsDb, "job-1", validPayload(1), 1);
    insertEvent(obsDb, "job-2", validPayload(2), 2);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(badCursor);
    const next = delta.cursor as { forensic_rowid: number; updated_at_ms: number };
    // invalid cursors are rejected (not coerced) and replay from start, so the
    // existing rows are actually emitted rather than merely landing in range
    expect(Number.isSafeInteger(next.forensic_rowid)).toBe(true);
    expect(next.forensic_rowid).toBe(2);
    expect(delta.forensicEvents.some((e) => e.source_event_id === "forensic:1")).toBe(true);
    expect(delta.forensicEvents.some((e) => e.source_event_id === "forensic:2")).toBe(true);
    obsDb.close();
  });

  it("bounds an oversized persisted job_id tie-break and still drains equal-timestamp jobs", async () => {
    const root = makeTempDir("obs-jobid-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    const stmt = obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    for (const id of ["job-a", "job-b", "job-c"]) stmt.run(id, "executor", "done", null, ts);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const hostile = { updated_at_ms: ts, job_id: "x".repeat(JOB_ID_MAX_LEN + 512), event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(hostile);
    // oversized tie-break is reset, so the equal-timestamp bucket replays fully
    expect(delta.rows.map((r) => r.job_id).sort()).toEqual(["job-a", "job-b", "job-c"]);
    const nextJobId = (delta.cursor as { job_id: string }).job_id;
    expect(nextJobId.length).toBeLessThanOrEqual(JOB_ID_MAX_LEN);
    obsDb.close();
  });

  it("reset-aware replay: extreme-ahead cursor replays from start and emits the high-water row (not skipped)", async () => {
    const root = makeTempDir("obs-hwm-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertEvent(obsDb, "job-1", validPayload(1), 1);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const replayed = await adapter.changesSince({ ...ZERO_CURSOR, forensic_rowid: 1e15 });
    // the row AT the old high-water is emitted, not silently skipped
    expect(replayed.forensicEvents.some((e) => e.source_event_id === "forensic:1")).toBe(true);
    expect((replayed.cursor as { forensic_rowid: number }).forensic_rowid).toBe(1);
    // a new row above the high-water is still observed (forward progress)
    insertEvent(obsDb, "job-2", validPayload(2), 2);
    const next = await adapter.changesSince(replayed.cursor);
    expect(next.forensicEvents.some((e) => e.source_event_id === "forensic:2")).toBe(true);
    expect((next.cursor as { forensic_rowid: number }).forensic_rowid).toBe(2);
    obsDb.close();
  });

  it("source reset: high-water drops and cursor re-clamps so replay makes forward progress", async () => {
    const root = makeTempDir("obs-reset-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertEvent(obsDb, "job-1", validPayload(1), 1);
    insertEvent(obsDb, "job-2", validPayload(2), 2);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");
    const first = await adapter.changesSince(ZERO_CURSOR);
    expect((first.cursor as { forensic_rowid: number }).forensic_rowid).toBe(2);

    // reset source: drop+recreate so the rowid high-water drops below the old cursor
    obsDb.exec("DROP TABLE specialist_forensic_events");
    obsDb.exec(`CREATE TABLE specialist_forensic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT, seq INTEGER, t INTEGER, schema_version TEXT, event_family TEXT,
      event_name TEXT, participant_kind TEXT, participant_role TEXT, participant_id TEXT,
      redaction_status TEXT, event_json TEXT
    )`);
    insertEvent(obsDb, "job-9", validPayload(9), 1);
    const after = await adapter.changesSince(first.cursor);
    const next = after.cursor as { forensic_rowid: number };
    expect(Number.isFinite(next.forensic_rowid)).toBe(true);
    // replayed from start: the reset row is emitted (not skipped) and cursor lands on new high-water
    expect(after.forensicEvents.some((e) => e.source_event_id === "forensic:1" && e.job_id === "job-9")).toBe(true);
    expect(next.forensic_rowid).toBe(1);
    obsDb.close();
  });

  it("redacts raw invalid cursor text from materializer logs", async () => {
    const root = makeTempDir("obs-redact-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createSourceDb(obsDbPath);
    insertEvent(obsDb, "job-1", validPayload(1), 1);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const secret = "SECRET-RAW-CURSOR-xyzzy";
    // drop the json_valid CHECK (test-only) so an invalid cursor can be planted
    xtrmDb.exec("DROP TABLE materialization_state");
    xtrmDb.exec("CREATE TABLE materialization_state (source_key TEXT PRIMARY KEY, cursor TEXT, last_run_at DATETIME, last_success_at DATETIME, last_status TEXT, last_error TEXT)");
    xtrmDb.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("obs:repo-1", `{not-json:${secret}`);

    const entries: MaterializerLogEntry[] = [];
    const hooks: MaterializerHooks = { emitLog: (entry) => entries.push(entry) };
    const materializer = new Materializer(xtrmDb, undefined, hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));
    await materializer.runOnce("obs:repo-1");

    const invalid = entries.find((e) => e.event === "materializer.cursor.invalid");
    expect(invalid).toBeDefined();
    expect(invalid!.data?.cursor_redacted).toBe(true);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secret);
    obsDb.close();
  });

  it("stress probe: oversized rows do not blow up heap; per-run writes stay bounded", async () => {
    const root = makeTempDir("obs-stress-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = createSourceDb(obsDbPath);
    // production-shaped read-only source copy: many oversized event payloads
    const oversized = JSON.stringify({ schema_version: "xtrm.forensic.v1", pad: "z".repeat(EVENT_PAYLOAD_MAX_BYTES + 8192) });
    for (let i = 1; i <= 40; i++) insertEvent(obsDb, `job-${i}`, oversized, i);
    obsDb.exec("PRAGMA query_only = ON");

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage();
    await materializer.runOnce("obs:repo-1");
    const after = process.memoryUsage();

    const written = (xtrmDb.query("SELECT COUNT(*) AS c FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { c: number }).c;
    expect(written).toBe(40);
    // bounded markers only: no oversized payload text persisted
    const biggest = (xtrmDb.query("SELECT MAX(length(envelope_json)) AS m FROM xtrm_forensic_events WHERE source_key = 'obs:repo-1'").get() as { m: number }).m;
    expect(biggest).toBeLessThan(2048);
    // heap growth stays bounded well below the raw payload volume (~40 * 256KB = 10MB)
    const heapGrowth = after.heapUsed - before.heapUsed;
    expect(heapGrowth).toBeLessThan(8 * 1024 * 1024);
    obsDb.close();
  });
});
