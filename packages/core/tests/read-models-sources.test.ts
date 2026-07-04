import { describe, expect, it } from "vitest";
import {
  buildSourceKey,
  getBeadsSourcePath,
  getSourceRow,
  hasHistoricalData,
  isAllowedSourceKind,
  isMutableManualSource,
  listSources,
  parseSourceKey,
  pinSource,
  readSourceMaterializationState,
  unpinSource,
} from "../src/state/index.ts";

const itWithBunSqlite = "Bun" in globalThis ? it : it.skip;

describe("sources read model", () => {
  itWithBunSqlite("returns empty list when database is null", () => {
    expect(listSources(null)).toEqual([]);
    expect(getSourceRow(null, "beads:/repo")).toBeNull();
    expect(hasHistoricalData(null, "beads:/repo")).toBe(false);
  });

  it("parses and builds opaque source keys", () => {
    expect(buildSourceKey("beads", "/repo")).toBe("beads:/repo");
    expect(parseSourceKey("beads:/repo")).toEqual({ kind: "beads", path: "/repo" });
    expect(parseSourceKey("plain")).toEqual({ kind: "beads", path: "plain" });
  });

  it("classifies allowed source kinds and manual sources", () => {
    expect(isAllowedSourceKind("beads")).toBe(true);
    expect(isAllowedSourceKind("observability")).toBe(true);
    expect(isAllowedSourceKind("github")).toBe(true);
    expect(isAllowedSourceKind("unknown")).toBe(false);
    expect(isMutableManualSource({ source_key: "x", kind: "beads", path: "/x", origin: "manual", status: "active", discovered_at: null, last_seen_at: null })).toBe(true);
    expect(isMutableManualSource({ source_key: "x", kind: "beads", path: "/x", origin: "discovered", status: "active", discovered_at: null, last_seen_at: null })).toBe(false);
  });

  itWithBunSqlite("pins a new source and upserts on repeat pin", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSourcesDb(Database);
    expect(pinSource(db, "beads", "/repo")).toEqual({ source_key: "beads:/repo", kind: "beads", path: "/repo" });
    expect(pinSource(db, "beads", "/repo")).toEqual({ source_key: "beads:/repo", kind: "beads", path: "/repo" });
    const row = db.query<{ origin: string; status: string }, []>("SELECT origin, status FROM sources WHERE source_key = 'beads:/repo'").get();
    expect(row?.origin).toBe("manual");
    expect(row?.status).toBe("active");
  });

  itWithBunSqlite("tombstones manual sources with historical data and deletes otherwise", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSourcesDb(Database);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:/repo', 'beads', '/repo', 'manual', 'active')").run();
    db.query("INSERT INTO materialization_state (source_key) VALUES ('beads:/repo')").run();
    expect(unpinSource(db, "beads:/repo")).toEqual({ source_key: "beads:/repo", status: "unpinned" });
    expect(getSourceRow(db, "beads:/repo")?.status).toBe("unpinned");

    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:/fresh', 'beads', '/fresh', 'manual', 'active')").run();
    expect(unpinSource(db, "beads:/fresh")).toEqual({ source_key: "beads:/fresh", status: "deleted" });
    expect(getSourceRow(db, "beads:/fresh")).toBeNull();
  });

  itWithBunSqlite("detects historical data per source kind", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSourcesDb(Database);
    db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at) VALUES ('demo', 'i1', 't', 'open', 'task', 1, '2026-01-01', '2026-01-01')").run();
    expect(hasHistoricalData(db, "beads:demo")).toBe(true);

    db.query("INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist) VALUES ('repo-a', 'j1', 'b1', 'observability:repo-a', NULL, 'executor', 'running', '2026-01-01', 'executor')").run();
    expect(hasHistoricalData(db, "observability:repo-a")).toBe(true);

    expect(hasHistoricalData(db, "unknown:kind")).toBe(false);
  });

  itWithBunSqlite("resolves a beads source path by project id", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSourcesDb(Database);
    expect(getBeadsSourcePath(db, "demo")).toBeNull();
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', '/repos/demo/.beads', 'manual', 'active')").run();
    expect(getBeadsSourcePath(db, "demo")).toBe("/repos/demo/.beads");
    expect(getBeadsSourcePath(null, "demo")).toBeNull();
  });

  itWithBunSqlite("reads single-source materialization state including last_error", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSourcesDb(Database);
    expect(readSourceMaterializationState(db, "beads:demo")).toBeNull();
    expect(readSourceMaterializationState(null, "beads:demo")).toBeNull();
    db.query("INSERT INTO materialization_state (source_key, last_status, last_success_at, last_error) VALUES ('beads:demo', 'error', '2026-01-01', 'boom')").run();
    expect(readSourceMaterializationState(db, "beads:demo")).toEqual({ last_status: "error", last_success_at: "2026-01-01", last_error: "boom" });
  });
});

function createSourcesDb(DatabaseCtor: typeof import("bun:sqlite").Database) {
  const db = new DatabaseCtor(":memory:");
  db.exec(`
    CREATE TABLE sources (
      source_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT,
      origin TEXT,
      status TEXT,
      discovered_at DATETIME,
      last_seen_at DATETIME
    );
    CREATE TABLE materialization_state (
      source_key TEXT PRIMARY KEY,
      cursor TEXT,
      last_run_at DATETIME,
      last_success_at DATETIME,
      last_status TEXT,
      last_error TEXT
    );
    CREATE TABLE substrate_issues (
      repo_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      title TEXT,
      state TEXT,
      issue_type TEXT,
      priority INTEGER,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (repo_slug, issue_id)
    );
    CREATE TABLE specialist_jobs (
      job_id TEXT PRIMARY KEY,
      repo_slug TEXT NOT NULL,
      bead_id TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at TEXT,
      specialist TEXT
    );
  `);
  return db;
}
