import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { createDatabase, TABLES } from "../../../../packages/core/src/github/database.ts";
import { mkdtemp, rmdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("createDatabase", () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-forge-test-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a database file at the given path", () => {
    const db = createDatabase(dbPath);
    expect(db).toBeDefined();
    db.close();
  });

  it("creates all 6 required tables", () => {
    const db = createDatabase(dbPath);
    const tableNames = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("specialist_events");
    expect(tableNames).toContain("github_events");
    expect(tableNames).toContain("github_commits");
    expect(tableNames).toContain("github_repos");
    db.close();
  });

  it("enables WAL mode", () => {
    const db = createDatabase(dbPath);
    const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(row?.journal_mode).toBe("wal");
    db.close();
  });

  it("is idempotent — calling twice on same path works", () => {
    const db1 = createDatabase(dbPath);
    db1.close();
    const db2 = createDatabase(dbPath);
    const tableCount = db2
      .query<{ c: number }, []>("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'")
      .get();
    expect(tableCount?.c).toBeGreaterThanOrEqual(6);
    db2.close();
  });

  it("creates indexes on github_events", () => {
    const db = createDatabase(dbPath);
    const indexes = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='github_events'")
      .all()
      .map((r) => r.name);
    expect(indexes.length).toBeGreaterThan(0);
    db.close();
  });

  it("keeps specialist telemetry token-first with USD provenance deferred", () => {
    const db = createDatabase(dbPath);
    const columns = db
      .query<{ name: string; type: string }, []>("PRAGMA table_info(specialist_events)")
      .all();
    const columnType = new Map(columns.map((column) => [column.name, column.type]));

    for (const column of ["tokens_in", "tokens_out", "token_cache_read", "token_cache_creation", "token_reasoning", "token_tool"]) {
      expect(columnType.get(column)).toBe("INTEGER");
    }
    expect(columnType.get("usage_source")).toBe("TEXT");
    expect(columnType.get("cost_usd")).toBe("REAL");
    expect(columnType.get("cost_usd_provenance")).toBe("TEXT");

    db.close();
  });

  it("TABLES constant lists all table names", () => {
    expect(TABLES).toContain("sessions");
    expect(TABLES).toContain("messages");
    expect(TABLES).toContain("specialist_events");
    expect(TABLES).toContain("github_events");
    expect(TABLES).toContain("github_commits");
    expect(TABLES).toContain("github_repos");
  });
});
