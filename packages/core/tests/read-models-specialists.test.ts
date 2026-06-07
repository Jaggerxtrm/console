import { describe, expect, it } from "vitest";
import {
  readMaterializationState,
  readSpecialistChainJobs,
  readSpecialistFeedEvents,
  readSpecialistInFlightJobs,
  readSpecialistJobResult,
  readSpecialistJobsByBead,
  readSpecialistRecentJobs,
} from "../src/state/index.ts";

const itWithBunSqlite = "Bun" in globalThis ? it : it.skip;

describe("specialists read model", () => {
  itWithBunSqlite("returns empty arrays when the database is null", () => {
    expect(readSpecialistJobsByBead(null, "bead-1")).toEqual([]);
    expect(readSpecialistInFlightJobs(null)).toEqual([]);
    expect(readSpecialistRecentJobs(null, 10)).toEqual([]);
    expect(readSpecialistChainJobs(null, "chain-1")).toEqual([]);
    expect(readSpecialistFeedEvents(null, "repo-a", "job-1")).toEqual([]);
    expect(readSpecialistJobResult(null, "job-1")).toBeNull();
    expect(readMaterializationState(null)).toEqual([]);
  });

  itWithBunSqlite("correlates specialist jobs to beads via the bead_id column or substrate_job_link", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database);
    db.exec(`
      INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist)
      VALUES
        ('repo-a', 'job-1', 'bead-1', 'chain-1', 'epic-1', 'executor', 'running', '2026-01-01T00:00:00.000Z', 'executor'),
        ('repo-a', 'job-2', 'bead-2', 'chain-1', 'epic-1', 'reviewer', 'running', '2026-01-01T00:00:01.000Z', 'reviewer');
      INSERT INTO substrate_job_link (repo_slug, job_id, issue_id)
      VALUES ('repo-a', 'job-1', 'bead-X');
    `);

    const byBead = readSpecialistJobsByBead(db, "bead-X");
    expect(byBead.map((job) => job.jobId)).toEqual(["job-1"]);
    expect(byBead[0]).toEqual(expect.objectContaining({ jobId: "job-1", beadId: "bead-X", repoSlug: "repo-a", chainId: "chain-1", status: "running" }));
  });

  itWithBunSqlite("filters in-flight and recent jobs and falls back to chain_id or job_id", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database);
    db.exec(`
      INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist)
      VALUES
        ('repo-a', 'j1', 'b1', 'c1', 'e1', 'executor', 'running', '2026-01-01T00:00:00.000Z', 'executor'),
        ('repo-a', 'j2', 'b2', 'c1', 'e1', 'reviewer', 'done', '2026-01-01T00:00:01.000Z', 'reviewer'),
        ('repo-a', 'j3', 'b3', 'c2', 'e2', 'reviewer', 'failed', '2026-01-01T00:00:02.000Z', 'reviewer'),
        ('repo-a', 'standalone', 'bs', NULL, NULL, 'executor', 'done', '2026-01-01T00:00:03.000Z', 'executor');
    `);

    expect(readSpecialistInFlightJobs(db).map((job) => job.jobId)).toEqual(["j1"]);
    expect(readSpecialistRecentJobs(db, 10).map((job) => job.jobId)).toEqual(["standalone", "j3", "j2"]);
    expect(readSpecialistChainJobs(db, "c1").map((job) => job.jobId)).toEqual(["j2", "j1"]);
    expect(readSpecialistChainJobs(db, "standalone").map((job) => job.jobId)).toEqual(["standalone"]);
  });

  itWithBunSqlite("preserves bead_id and repo_slug under repo filtering", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database);
    db.exec(`
      INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist)
      VALUES
        ('repo-a', 'j-a', 'b1', NULL, NULL, 'executor', 'running', '2026-01-01', 'executor'),
        ('repo-b', 'j-b', 'b1', NULL, NULL, 'executor', 'running', '2026-01-01', 'executor');
    `);

    const filtered = readSpecialistInFlightJobs(db, { repoSlugs: ["repo-a"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.repoSlug).toBe("repo-a");
  });

  itWithBunSqlite("returns the latest result/terminal_output event for a job", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database);
    db.exec(`
      INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload, created_at)
      VALUES
        ('repo-a', 'job-1', 'result', '# old', '2026-01-01T00:00:00.000Z'),
        ('repo-a', 'job-1', 'result', '# done', '2026-01-02T00:00:00.000Z'),
        ('repo-a', 'job-1', 'terminal_output', 'fallback', '2026-01-03T00:00:00.000Z');
    `);

    expect(readSpecialistJobResult(db, "job-1")).toEqual({ text: "fallback", contentType: "text/markdown" });
    expect(readSpecialistJobResult(db, "missing")).toBeNull();
  });

  itWithBunSqlite("sanitizes forensic envelopes, preserving canonical keys and dropping unknown top-level keys", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database, { freshForensic: true });
    db.exec(`DELETE FROM xtrm_forensic_events;`);
    db.prepare("INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", 10, 1, "{}");
    db.prepare("INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", 20, 2, "{}");
    const a = JSON.stringify({
      schema_version: "xtrm.forensic.v1",
      timestamp: "2026-01-01T00:00:01.000Z",
      t_unix_ms: 10,
      seq: 1,
      severity: "info",
      event_family: "job",
      event_name: "job.started",
      event_version: 1,
      resource: { participant_kind: "agent" },
      correlation: { job_id: "job-1" },
      body: { mode: "test" },
      redaction: { status: "clean" },
      trace: { trace_id: "trace-1" },
      links: { dashboard: "/console" },
      secret: "top-secret",
    });
    const b = JSON.stringify({
      schema_version: "xtrm.forensic.v1",
      timestamp: "2026-01-01T00:00:02.000Z",
      t_unix_ms: 20,
      seq: 2,
      severity: "info",
      event_family: "job",
      event_name: "job.completed",
      event_version: 1,
      body: { elapsed_ms: 15 },
    });
    db.prepare("UPDATE xtrm_forensic_events SET envelope_json = ? WHERE t_unix_ms = 10").run(a);
    db.prepare("UPDATE xtrm_forensic_events SET envelope_json = ? WHERE t_unix_ms = 20").run(b);

    const events = readSpecialistFeedEvents(db, "repo-a", "job-1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event_name: "job.started", body: { mode: "test" }, trace: { trace_id: "trace-1" } });
    expect(events[0]).not.toHaveProperty("secret");
    expect(events[1]).toMatchObject({ event_name: "job.completed", body: { elapsed_ms: 15 } });
  });

  itWithBunSqlite("falls back to specialist_job_events forensic_event rows when envelope_json column is absent", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSpecialistsDb(Database, { withoutEnvelopeColumn: true, freshForensic: true });
    db.exec(`DELETE FROM xtrm_forensic_events;`);
    db.exec(`
      INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload, created_at)
      VALUES
        ('repo-a', 'job-1', 'forensic_event', '{"event_name":"job.completed","seq":1,"t_unix_ms":1}', '2026-01-01T00:00:00.000Z'),
        ('repo-a', 'job-1', 'forensic_event', 'not-json', '2026-01-01T00:00:01.000Z');
    `);
    const events = readSpecialistFeedEvents(db, "repo-a", "job-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_name: "job.completed" });
  });
});

function createSpecialistsDb(DatabaseCtor: typeof import("bun:sqlite").Database, options: { withoutEnvelopeColumn?: boolean; freshForensic?: boolean } = {}) {
  const db = new DatabaseCtor(":memory:");
  db.exec(`
    CREATE TABLE specialist_jobs (
      job_id TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      bead_id TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at TEXT,
      updated_at_ms INTEGER,
      specialist TEXT,
      last_output TEXT,
      turns INTEGER,
      tools INTEGER,
      model TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_cache_read INTEGER,
      token_cache_creation INTEGER,
      token_reasoning INTEGER,
      token_tool INTEGER,
      usage_source TEXT
    );
    CREATE TABLE specialist_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE xtrm_forensic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT,
      t_unix_ms INTEGER,
      seq INTEGER${options.withoutEnvelopeColumn ? "" : ",\n      envelope_json TEXT"}
    );
    CREATE TABLE substrate_job_link (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      issue_id TEXT,
      PRIMARY KEY (repo_slug, job_id)
    );
    CREATE TABLE materialization_state (
      source_key TEXT PRIMARY KEY,
      cursor TEXT,
      last_run_at DATETIME,
      last_success_at DATETIME,
      last_status TEXT,
      last_error TEXT
    );
  `);
  if (options.withoutEnvelopeColumn) {
    if (!options.freshForensic) {
      db.exec(`
        INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq) VALUES ('repo-a', 'job-1', 10, 1);
        INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq) VALUES ('repo-a', 'job-1', 20, 2);
      `);
    }
  } else {
    if (!options.freshForensic) {
      db.exec(`
        INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES ('repo-a', 'job-1', 10, 1, '{}');
        INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES ('repo-a', 'job-1', 20, 2, '{}');
      `);
    }
  }
  return db;
}
