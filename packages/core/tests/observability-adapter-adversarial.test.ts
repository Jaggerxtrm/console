/**
 * Adversarial gap-closure tests for the bounded observability materializer.
 *
 * Covers mandate items absent from backfill/bounds suites:
 *  - 499/501 off-by-one event and job batch boundaries
 *  - legacy cursor missing job_id field
 *  - short lexicographically-ahead job_id at max timestamp (must not suppress)
 *  - Unicode byte-vs-character SQL caps (multi-byte chars)
 *  - write failure schedules no continuation
 *  - touched job max cardinality
 *  - Bun-native vs Node-shim runtime assertion
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../src/state/database.ts";
import { Materializer, type MaterializerHooks, type MaterializerLogEntry } from "../src/materializer/materializer.ts";
import { COALESCE_MS } from "../src/materializer/queue.ts";
import {
  createObservabilityAdapter,
  EVENT_PAYLOAD_MAX_BYTES,
  FORENSIC_BATCH_SIZE,
  JOB_BATCH_SIZE,
  LAST_OUTPUT_MAX_BYTES,
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

function validPayload(i: number, body: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i,
    severity: "info", event_family: "job", event_name: "job.step", event_version: 1,
    resource: {}, correlation: { job_id: `job-${i}` }, body, redaction: { status: "clean" },
  });
}

function createSourceDb(dbPath: string): Database {
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
  return db;
}

function insertJobs(db: Database, count: number, ts: number): void {
  const stmt = db.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
  for (let i = 1; i <= count; i++) {
    stmt.run(`job-${String(i).padStart(6, "0")}`, "executor", "done", null, ts);
  }
}

function insertEvents(db: Database, count: number): void {
  const stmt = db.query(
    "INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 1; i <= count; i++) {
    stmt.run(`job-${i}`, i, 1700000000000 + i, "xtrm.forensic.v1", "job", "job.step", "specialist", "executor", `p-${i}`, "clean", validPayload(i));
  }
}

const ZERO_CURSOR = { updated_at_ms: 0, job_id: "", event_rowid: 0, forensic_rowid: 0 };

// ---------------------------------------------------------------------------
// 499/501 off-by-one event boundaries
// ---------------------------------------------------------------------------
describe("adversarial: event batch off-by-one boundaries", () => {
  it("499 events (FORENSIC_BATCH_SIZE-1): single batch, hasMore=false, no continuation needed", async () => {
    const root = makeTempDir("obs-499ev-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertEvents(obsDb, FORENSIC_BATCH_SIZE - 1);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    expect(delta.forensicEvents.length).toBe(FORENSIC_BATCH_SIZE - 1);
    expect(delta.hasMore).toBe(false);
    expect((delta.cursor as { forensic_rowid: number }).forensic_rowid).toBe(FORENSIC_BATCH_SIZE - 1);
    obsDb.close();
  });

  it("501 events (FORENSIC_BATCH_SIZE+1): first batch capped at 500, hasMore=true, second batch gets remainder", async () => {
    const root = makeTempDir("obs-501ev-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertEvents(obsDb, FORENSIC_BATCH_SIZE + 1);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const first = await adapter.changesSince(ZERO_CURSOR);
    expect(first.forensicEvents.length).toBe(FORENSIC_BATCH_SIZE);
    expect(first.hasMore).toBe(true);
    expect((first.cursor as { forensic_rowid: number }).forensic_rowid).toBe(FORENSIC_BATCH_SIZE);

    const second = await adapter.changesSince(first.cursor);
    expect(second.forensicEvents.length).toBe(1);
    expect(second.hasMore).toBe(false);
    expect((second.cursor as { forensic_rowid: number }).forensic_rowid).toBe(FORENSIC_BATCH_SIZE + 1);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// 499/501 off-by-one job boundaries
// ---------------------------------------------------------------------------
describe("adversarial: job batch off-by-one boundaries", () => {
  it("499 jobs (JOB_BATCH_SIZE-1): single batch, hasMore=false", async () => {
    const root = makeTempDir("obs-499job-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertJobs(obsDb, JOB_BATCH_SIZE - 1, 1700000000000);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    expect(delta.rows.length).toBe(JOB_BATCH_SIZE - 1);
    expect(delta.hasMore).toBe(false);
    obsDb.close();
  });

  it("501 jobs (JOB_BATCH_SIZE+1): first batch capped at 500, hasMore=true, second batch gets remainder", async () => {
    const root = makeTempDir("obs-501job-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertJobs(obsDb, JOB_BATCH_SIZE + 1, 1700000000000);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const first = await adapter.changesSince(ZERO_CURSOR);
    expect(first.rows.length).toBe(JOB_BATCH_SIZE);
    expect(first.hasMore).toBe(true);

    const second = await adapter.changesSince(first.cursor);
    expect(second.rows.length).toBe(1);
    expect(second.hasMore).toBe(false);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Legacy cursor missing job_id field
// ---------------------------------------------------------------------------
describe("adversarial: legacy cursor normalization", () => {
  it("cursor object without job_id property normalizes to empty string and pages correctly", async () => {
    const root = makeTempDir("obs-nojobid-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertJobs(obsDb, 3, 1700000000000);
    insertEvents(obsDb, 2);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor with NO job_id field at all (legacy shape)
    const legacyCursor = { updated_at_ms: 0, event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(legacyCursor);
    expect(delta.rows.length).toBe(3);
    expect(delta.forensicEvents.length).toBe(2);
    expect((delta.cursor as { job_id: string }).job_id).toBeDefined();
    obsDb.close();
  });

  it("cursor with null job_id normalizes safely", async () => {
    const root = makeTempDir("obs-nulljobid-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertJobs(obsDb, 2, 1700000000000);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const nullCursor = { updated_at_ms: 0, job_id: null, event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(nullCursor);
    expect(delta.rows.length).toBe(2);
    obsDb.close();
  });

  it("cursor with numeric job_id (non-string) normalizes to empty and replays", async () => {
    const root = makeTempDir("obs-numjobid-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    insertJobs(obsDb, 2, 1700000000000);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const numCursor = { updated_at_ms: 1700000000000, job_id: 42, event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(numCursor);
    // non-string job_id → normalized to "" → replays equal-timestamp bucket
    expect(delta.rows.length).toBe(2);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Short lexicographically-ahead job_id at max timestamp
// ---------------------------------------------------------------------------
describe("adversarial: lexicographically-ahead job_id tie-break", () => {
  // SOURCE BUG (forge-wv9i.20.20.9.15): normalizeCursor does not validate job_id
  // against the source data. A short, valid-length job_id that is lexicographically
  // ahead of all actual jobs at the max timestamp suppresses equal-timestamp rows.
  // Repro: cursor {updated_at_ms: T, job_id: "zzz"} with jobs "job-a","job-b","job-c"
  // at T → readJobsSince SQL `j.job_id > 'zzz'` returns nothing.
  // Fix: sourceHighWater should include MAX(job_id) and normalizeCursor should reset
  // job_id to "" when it exceeds the source high-water job_id.
  it("short job_id ahead of all actual jobs at max timestamp must not suppress equal-timestamp rows", async () => {
    const root = makeTempDir("obs-lexahead-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    // Jobs with ids that sort BEFORE "zzz"
    const stmt = obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    for (const id of ["job-a", "job-b", "job-c"]) stmt.run(id, "executor", "done", null, ts);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor claims "zzz" was the last-seen job at ts — but "zzz" never existed.
    // A correct adapter must not suppress the real equal-timestamp rows.
    const hostile = { updated_at_ms: ts, job_id: "zzz", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(hostile);

    // All three jobs at ts must be returned (not suppressed by the phantom tie-break)
    expect(delta.rows.map((r) => r.job_id).sort()).toEqual(["job-a", "job-b", "job-c"]);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Phantom cursor tie-breaker validation (forge-wv9i.20.20.9.15)
// ---------------------------------------------------------------------------
describe("adversarial: phantom cursor tie-breaker validation", () => {
  function seedJobs(db: Database, ids: readonly string[], ts: number): void {
    const stmt = db.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    for (const id of ids) stmt.run(id, "executor", "done", null, ts);
  }

  it("nonexistent middle job_id resets and replays the whole bucket (no skipped rows)", async () => {
    const root = makeTempDir("obs-phantom-mid-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-c"], ts); // no "job-bb" exists
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // "job-bb" sorts between job-a and job-c but the exact tuple is absent →
    // phantom. Keeping it would skip job-a; reset replays the full bucket.
    const cursor = { updated_at_ms: ts, job_id: "job-bb", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows.map((r) => r.job_id).sort()).toEqual(["job-a", "job-c"]);
    obsDb.close();
  });

  it("nonexistent ahead job_id at a non-max timestamp does not suppress its bucket tail", async () => {
    const root = makeTempDir("obs-phantom-ahead-nonmax-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-b"], ts);
    // A real job with a higher id exists at a LATER timestamp (global MAX trap).
    seedJobs(obsDb, ["zzz-later"], ts + 1000);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Phantom "job-z" is ahead of the ts bucket max ("job-b") but below the global
    // max ("zzz-later"); the bucket must still replay rather than be suppressed.
    const cursor = { updated_at_ms: ts, job_id: "job-z", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    const ids = delta.rows.map((r) => r.job_id).sort();
    expect(ids).toContain("job-a");
    expect(ids).toContain("job-b");
    expect(ids).toContain("zzz-later");
    obsDb.close();
  });

  it("existing legitimate tuple continues after the anchor without replaying seen rows", async () => {
    const root = makeTempDir("obs-legit-tuple-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-b", "job-c"], ts);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor anchored on a real, already-seen job ("job-b") must keep its
    // tie-breaker and resume strictly after it.
    const cursor = { updated_at_ms: ts, job_id: "job-b", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows.map((r) => r.job_id)).toEqual(["job-c"]);
    obsDb.close();
  });

  it("deleted cursor anchor row below bucket max replays the bucket instead of skipping", async () => {
    const root = makeTempDir("obs-deleted-anchor-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-c"], ts); // "job-b" (the anchor) was pruned
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor anchor "job-b" no longer exists and sorts BELOW the surviving bucket
    // max ("job-c"). A bucket-max check would keep it and skip job-a; exact-tuple
    // validation resets and replays the whole bucket.
    const cursor = { updated_at_ms: ts, job_id: "job-b", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows.map((r) => r.job_id).sort()).toEqual(["job-a", "job-c"]);
    obsDb.close();
  });

  it("empty source with a phantom cursor returns no rows and does not throw", async () => {
    const root = makeTempDir("obs-empty-src-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath); // no jobs inserted
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const cursor = { updated_at_ms: 1700000000000, job_id: "zzz", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows).toEqual([]);
    expect(delta.hasMore).toBe(false);
    obsDb.close();
  });

  it("more than two equal-timestamp pages paginate completely with no drops or dupes", async () => {
    const root = makeTempDir("obs-eqts-pages-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const total = JOB_BATCH_SIZE * 2 + 5; // 3 pages: 500 + 500 + 5
    const obsDb = createSourceDb(obsDbPath);
    const stmt = obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    const expected: string[] = [];
    for (let i = 1; i <= total; i++) {
      const id = `pg-${String(i).padStart(6, "0")}`;
      expected.push(id);
      stmt.run(id, "executor", "done", null, ts);
    }
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const seen: string[] = [];
    let cursor: unknown = ZERO_CURSOR;
    let pages = 0;
    let hasMore = true;
    while (hasMore && pages < 10) {
      const delta = await adapter.changesSince(cursor);
      seen.push(...delta.rows.map((r) => r.job_id));
      cursor = delta.cursor;
      hasMore = delta.hasMore;
      pages++;
    }
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(total); // no dupes
    expect([...seen].sort()).toEqual(expected); // no drops, stable order
    obsDb.close();
  });

  it("source reset (cursor timestamp beyond high-water) replays from the start", async () => {
    const root = makeTempDir("obs-restart-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-b", "job-c"], ts);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor claims a timestamp far ahead of the source → reset/rewind → replay all.
    const cursor = { updated_at_ms: ts + 999999, job_id: "zzz", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows.map((r) => r.job_id).sort()).toEqual(["job-a", "job-b", "job-c"]);
    obsDb.close();
  });

  it("no-new: cursor at the exact max tuple returns nothing and holds the cursor", async () => {
    const root = makeTempDir("obs-no-new-");
    const obsDbPath = join(root, "obs.db");
    const ts = 1700000000000;
    const obsDb = createSourceDb(obsDbPath);
    seedJobs(obsDb, ["job-a", "job-b", "job-c"], ts);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    // Cursor anchored on the bucket max ("job-c") is legitimate → kept → no rows.
    const cursor = { updated_at_ms: ts, job_id: "job-c", event_rowid: 0, forensic_rowid: 0 };
    const delta = await adapter.changesSince(cursor);
    expect(delta.rows).toEqual([]);
    expect(delta.hasMore).toBe(false);
    const next = delta.cursor as { updated_at_ms: number; job_id: string };
    expect(next.updated_at_ms).toBe(ts);
    expect(next.job_id).toBe("job-c");
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Unicode byte-vs-character SQL caps
// ---------------------------------------------------------------------------
describe("adversarial: Unicode byte-vs-character SQL caps", () => {
  it("multi-byte last_output under character limit but over byte limit is capped", async () => {
    const root = makeTempDir("obs-uni-lo-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    // 🎉 is 4 bytes in UTF-8. Use enough to exceed LAST_OUTPUT_MAX_BYTES in bytes
    // while staying well under the character count.
    const emojiCount = Math.floor(LAST_OUTPUT_MAX_BYTES / 4) + 10; // ~16K chars, ~64K+ bytes
    const unicodePayload = "🎉".repeat(emojiCount);
    // Sanity: character length < byte length
    expect(unicodePayload.length).toBeLessThan(LAST_OUTPUT_MAX_BYTES);
    expect(Buffer.byteLength(unicodePayload, "utf8")).toBeGreaterThan(LAST_OUTPUT_MAX_BYTES);

    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run("job-uni", "executor", "done", unicodePayload, 1700000000001);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const row = delta.rows.find((r) => r.job_id === "job-uni");
    expect(row).toBeDefined();
    // Must be capped: the raw multi-byte payload must NOT be materialized
    expect(row!.last_output).not.toBe(unicodePayload);
    expect(row!.last_output).toContain("oversized:last_output");
    obsDb.close();
  });

  it("multi-byte event_json under character limit but over byte limit emits oversized marker", async () => {
    const root = makeTempDir("obs-uni-ev-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    // Build a JSON payload with multi-byte padding that exceeds EVENT_PAYLOAD_MAX_BYTES in bytes
    const emojiPad = "🎉".repeat(Math.floor(EVENT_PAYLOAD_MAX_BYTES / 4) + 10);
    const hugePayload = JSON.stringify({ schema_version: "xtrm.forensic.v1", pad: emojiPad });
    expect(hugePayload.length).toBeLessThan(EVENT_PAYLOAD_MAX_BYTES * 2); // chars under 2x
    expect(Buffer.byteLength(hugePayload, "utf8")).toBeGreaterThan(EVENT_PAYLOAD_MAX_BYTES);

    obsDb.query(
      "INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("job-1", 1, 1700000000001, "xtrm.forensic.v1", "job", "job.step", "specialist", "executor", "p-1", "clean", hugePayload);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const marker = delta.forensicEvents.find((e) => e.source_event_id === "forensic:1");
    expect(marker).toBeDefined();
    expect(marker!.event_name).toBe("observability.payload.oversized");
    expect(marker!.envelope_json).not.toContain("🎉");
    obsDb.close();
  });

  it("multi-byte last_output exactly at byte boundary is NOT capped (boundary precision)", async () => {
    const root = makeTempDir("obs-uni-exact-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    // Exactly LAST_OUTPUT_MAX_BYTES bytes using 4-byte emoji (must be divisible)
    const exactCount = Math.floor(LAST_OUTPUT_MAX_BYTES / 4);
    const exactPayload = "🎉".repeat(exactCount);
    expect(Buffer.byteLength(exactPayload, "utf8")).toBe(LAST_OUTPUT_MAX_BYTES);

    obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run("job-exact", "executor", "done", exactPayload, 1700000000001);
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    const row = delta.rows.find((r) => r.job_id === "job-exact");
    expect(row).toBeDefined();
    // At exactly the byte limit, the payload should be materialized (<= cap)
    expect(row!.last_output).toBe(exactPayload);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Write failure schedules no continuation
// ---------------------------------------------------------------------------
describe("adversarial: write failure safety", () => {
  it("write failure with hasMore source does not schedule continuation", async () => {
    const root = makeTempDir("obs-nocont-");
    const obsDbPath = join(root, "obs.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    // Source has >FORENSIC_BATCH_SIZE rows → hasMore=true
    const obsDb = createSourceDb(obsDbPath);
    insertEvents(obsDb, FORENSIC_BATCH_SIZE + 10);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    // Corrupt target to force write failure
    xtrmDb.exec("DROP TABLE xtrm_forensic_events");

    const entries: MaterializerLogEntry[] = [];
    const hooks: MaterializerHooks = { emitLog: (entry) => entries.push(entry) };
    const materializer = new Materializer(xtrmDb, undefined, hooks);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    // Direct runOnce throws
    await expect(materializer.runOnce("obs:repo-1")).rejects.toThrow();

    // Cursor must not advance
    const state = xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = 'obs:repo-1'").get() as { cursor: string | null } | undefined;
    if (state?.cursor) {
      expect(JSON.parse(state.cursor).forensic_rowid).toBe(0);
    }

    // No continuation: wait longer than COALESCE_MS and verify no additional runs
    const runCountBefore = entries.filter((e) => e.event === "materializer.run").length;
    await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 500));
    const runCountAfter = entries.filter((e) => e.event === "materializer.run").length;
    expect(runCountAfter).toBe(runCountBefore); // no continuation scheduled
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Touched job max cardinality
// ---------------------------------------------------------------------------
describe("adversarial: touched job cardinality", () => {
  it("events referencing FORENSIC_BATCH_SIZE distinct jobs returns bounded touched-job set", async () => {
    const root = makeTempDir("obs-touched-");
    const obsDbPath = join(root, "obs.db");
    const obsDb = createSourceDb(obsDbPath);
    // Insert FORENSIC_BATCH_SIZE jobs and events, each event referencing a distinct job.
    // The envelope correlation.job_id must match the DB job_id column so the
    // materialized forensic event's job_id aligns with the touched-job lookup.
    const jobStmt = obsDb.query("INSERT INTO specialist_jobs (job_id, specialist, status, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?)");
    const evStmt = obsDb.query(
      "INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= FORENSIC_BATCH_SIZE; i++) {
      const jobId = `touched-${String(i).padStart(6, "0")}`;
      jobStmt.run(jobId, "executor", "done", null, 1700000000000 + i);
      const payload = JSON.stringify({
        schema_version: "xtrm.forensic.v1", t_unix_ms: 1700000000000 + i, seq: i,
        severity: "info", event_family: "job", event_name: "job.step", event_version: 1,
        resource: {}, correlation: { job_id: jobId }, body: {}, redaction: { status: "clean" },
      });
      evStmt.run(jobId, i, 1700000000000 + i, "xtrm.forensic.v1", "job", "job.step", "specialist", "executor", `p-${i}`, "clean", payload);
    }
    const adapter = createObservabilityAdapter(obsDbPath, "repo-1");

    const delta = await adapter.changesSince(ZERO_CURSOR);
    // Touched jobs are bounded by the event batch size (FORENSIC_BATCH_SIZE)
    expect(delta.forensicEvents.length).toBe(FORENSIC_BATCH_SIZE);
    // All touched jobs should be present in the merged output
    const touchedJobIds = new Set(delta.forensicEvents.map((e) => e.job_id));
    const returnedJobIds = new Set(delta.rows.map((r) => r.job_id));
    for (const jobId of touchedJobIds) {
      expect(returnedJobIds.has(jobId)).toBe(true);
    }
    // Total rows bounded: pageJobs + touchedJobs merged (deduped by job_id)
    expect(delta.rows.length).toBeLessThanOrEqual(FORENSIC_BATCH_SIZE + JOB_BATCH_SIZE);
    obsDb.close();
  });
});

// ---------------------------------------------------------------------------
// Bun-native vs Node-shim runtime assertion
// ---------------------------------------------------------------------------
describe("adversarial: runtime detection", () => {
  it("Database constructor matches the active runtime (Bun-native or Node-shim)", () => {
    const isBun = typeof process.versions.bun === "string";
    if (isBun) {
      // Under Bun, Database should be the native bun:sqlite Database
      expect(Database.name).toBe("Database");
      // Native bun:sqlite Database has a .filename property
      const root = makeTempDir("obs-rt-");
      const db = new Database(join(root, "rt.db"));
      expect(typeof db.close).toBe("function");
      db.close();
    } else {
      // Under Node, the vitest alias maps bun:sqlite → shim wrapping node:sqlite
      // The shim class is also named Database but wraps DatabaseSync
      const root = makeTempDir("obs-rt-");
      const db = new Database(join(root, "rt.db"));
      expect(typeof db.query).toBe("function");
      expect(typeof db.exec).toBe("function");
      expect(typeof db.close).toBe("function");
      // Verify the shim actually works (node:sqlite backed)
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      db.query("INSERT INTO t (v) VALUES (?)").run("hello");
      const row = db.query("SELECT v FROM t WHERE id = 1").get() as { v: string };
      expect(row.v).toBe("hello");
      db.close();
    }
  });
});
