import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createXtrmDatabase, XTRM_TABLES } from "../../src/core/xtrm-store.ts";

describe("createXtrmDatabase", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-xtrm-test-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates schema and WAL mode", () => {
    const db = createXtrmDatabase(dbPath);
    const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(journalMode?.journal_mode).toBe("wal");
    db.close();
  });

  it("is idempotent on repeated open", () => {
    const db1 = createXtrmDatabase(dbPath);
    db1.close();

    const db2 = createXtrmDatabase(dbPath);
    const tableCount = db2.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get();
    expect(tableCount?.c).toBeGreaterThanOrEqual(XTRM_TABLES.length);
    db2.close();
  });

  it("creates composite key tables and tombstone column", () => {
    const db = createXtrmDatabase(dbPath);

    db.exec("INSERT INTO substrate_issues (repo_slug, issue_id, state) VALUES ('repo-a', '1', 'open')");
    expect(() => {
      db.exec("INSERT INTO substrate_issues (repo_slug, issue_id, state) VALUES ('repo-a', '1', 'closed')");
    }).toThrow();

    const columns = db.query<{ name: string }, []>("PRAGMA table_info('substrate_issues')").all().map((row) => row.name);
    for (const column of ["priority", "issue_type", "owner", "labels", "related_ids", "parent_id", "deleted_at", "closed_at", "close_reason", "notes"]) {
      expect(columns).toContain(column);
    }

    const rows = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM substrate_issues WHERE repo_slug='repo-a' AND issue_id='1'").get();
    expect(rows?.c).toBe(1);

    db.close();
  });

  it("roundtrips tombstones and reopen", () => {
    const db = createXtrmDatabase(dbPath);

    db.exec("INSERT INTO substrate_issues (repo_slug, issue_id, state, deleted_at) VALUES ('repo-a', '9', 'open', NULL)");
    db.exec("UPDATE substrate_issues SET deleted_at = CURRENT_TIMESTAMP WHERE repo_slug='repo-a' AND issue_id='9'");

    const activeRows = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM substrate_issues WHERE repo_slug='repo-a' AND issue_id='9' AND deleted_at IS NULL").get();
    expect(activeRows?.c).toBe(0);

    const allRows = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM substrate_issues WHERE repo_slug='repo-a' AND issue_id='9'").get();
    expect(allRows?.c).toBe(1);

    db.exec("INSERT INTO substrate_issues (repo_slug, issue_id, state, deleted_at) VALUES ('repo-a', '9', 'open', NULL) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET deleted_at = excluded.deleted_at, state = excluded.state");

    const reopenedRows = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM substrate_issues WHERE repo_slug='repo-a' AND issue_id='9' AND deleted_at IS NULL").get();
    expect(reopenedRows?.c).toBe(1);

    db.close();
  });

  it("creates telemetry bridge tables and specialist metric columns", () => {
    const db = createXtrmDatabase(dbPath);

    const jobColumns = db.query<{ name: string }, []>("PRAGMA table_info('specialist_jobs')").all().map((row) => row.name);
    for (const column of ["turns", "tools", "model", "token_input", "token_output", "token_cache_read", "token_cache_creation", "token_reasoning", "token_tool", "usage_source"]) {
      expect(jobColumns).toContain(column);
    }

    const eventColumns = db.query<{ name: string }, []>("PRAGMA table_info('xtrm_forensic_events')").all().map((row) => row.name);
    for (const column of ["source_key", "source_event_id", "repo_slug", "job_id", "seq", "t_unix_ms", "schema_version", "resource_json", "correlation_json", "body_json", "redaction_json", "envelope_json"]) {
      expect(eventColumns).toContain(column);
    }

    const evidenceColumns = db.query<{ name: string }, []>("PRAGMA table_info('xtrm_evidence_refs')").all().map((row) => row.name);
    for (const column of ["source_key", "repo_slug", "evidence_id", "evidence_kind", "job_id", "issue_id", "ref_json"]) {
      expect(evidenceColumns).toContain(column);
    }

    db.close();
  });
});
