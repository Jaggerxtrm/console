import { describe, expect, it } from "vitest";
import { readXtrmGraphSnapshot, resolveXtrmGraphSource } from "../src/state/index.ts";

const itWithBunSqlite = "Bun" in globalThis ? it : it.skip;

describe("graph read model (xtrm path)", () => {
  itWithBunSqlite("returns null source for missing project_id", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    expect(resolveXtrmGraphSource(db, "missing")).toBeNull();
  });

  itWithBunSqlite("marks missing project as degraded and includes a descriptive message", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    const result = readXtrmGraphSnapshot(db, "missing", false);
    expect(result.freshness).toBe("degraded");
    expect(result.sourceHealth?.status).toBe("degraded");
    expect(result.sourceHealth?.message).toContain("missing");
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.edges).toEqual([]);
  });

  itWithBunSqlite("joins issues, edges, and live specialists while preserving opaque IDs", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES
        ('gitboard', 'g-1', 'A', 'open', 'task', 1, '2026-01-01', '2026-01-01'),
        ('gitboard', 'g-2', 'B', 'open', 'bug', 2, '2026-01-01', '2026-01-01'),
        ('gitboard', 'g-3', 'C', 'closed', 'feature', 3, '2026-01-01', '2026-01-01'),
        ('gitboard', 'g-4', 'D', 'closed', 'epic', 4, '2026-01-01', '2026-01-01');
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation)
      VALUES
        ('gitboard', 'g-1', 'g-2', 'blocks'),
        ('gitboard', 'g-3', 'g-4', 'supersedes');
      INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist)
      VALUES
        ('gitboard', 'job-1', 'g-1', 'c1', NULL, 'executor', 'running', '2026-01-01T00:00:00.000Z', 'executor'),
        ('gitboard', 'job-2', 'g-2', 'c2', NULL, 'reviewer', 'waiting', '2026-01-02T00:00:00.000Z', 'reviewer'),
        ('gitboard', 'job-3', 'g-5', NULL, NULL, 'executor', 'done', '2026-01-01T00:00:00.000Z', 'executor');
    `);
    db.exec(`
      INSERT INTO materialization_state (source_key, last_status, last_success_at)
      VALUES ('beads:gitboard', 'success', '2026-01-01T00:00:00.000Z');
    `);

    const result = readXtrmGraphSnapshot(db, "gitboard", false);
    expect(result.freshness).toBe("fresh");
    expect(result.sourceHealth?.status).toBe("fresh");
    expect(result.graph.nodes.map((node) => node.id).sort()).toEqual(["g-1", "g-2"].sort());
    expect(result.graph.edges.map((edge) => edge.type).sort()).toEqual(["blocks"]);
    expect(result.graph.specialists.map((job) => job.bead_id)).toEqual(["g-2", "g-1"]);
  });

  itWithBunSqlite("derives degraded source health when last materialization is error", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES ('gitboard', 'g-1', 'A', 'open', 'task', 1, '2026-01-01', '2026-01-01');
      INSERT INTO materialization_state (source_key, last_status, last_success_at, last_error)
      VALUES ('beads:gitboard', 'error', '2026-01-01T00:00:00.000Z', 'boom');
    `);

    const result = readXtrmGraphSnapshot(db, "gitboard", false);
    expect(result.freshness).toBe("fresh");
    expect(result.sourceHealth?.status).toBe("degraded");
    expect(result.sourceHealth?.message).toContain("materialization failed");
  });

  itWithBunSqlite("excludes closed dependency ghost nodes from the active graph", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES
        ('gitboard', 'g-1', 'Open bead', 'open', 'task', 1, '2026-01-01', '2026-01-01'),
        ('gitboard', 'g-2', 'Closed bead', '"closed"', 'bug', 2, '2026-01-01', '2026-01-01');
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation)
      VALUES ('gitboard', 'g-1', 'g-2', 'blocks');
      INSERT INTO materialization_state (source_key, last_status, last_success_at)
      VALUES ('beads:gitboard', 'success', '2026-01-01T00:00:00.000Z');
    `);

    const active = readXtrmGraphSnapshot(db, "gitboard", false).graph;
    expect(active.nodes.map((node) => node.id)).toEqual(["g-1"]);
    expect(active.edges).toEqual([]);

    const historical = readXtrmGraphSnapshot(db, "gitboard", true).graph;
    expect(historical.nodes.map((node) => node.id).sort()).toEqual(["g-1", "g-2"]);
    expect(historical.edges).toEqual([{ from: "g-1", to: "g-2", type: "blocks" }]);
  });

  itWithBunSqlite("derives stale freshness when materialization has never succeeded", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createGraphDb(Database);
    const result = readXtrmGraphSnapshot(db, "gitboard", false);
    expect(result.freshness).toBe("stale");
    expect(result.sourceHealth?.status).toBe("degraded");
  });
});

function createGraphDb(DatabaseCtor: typeof import("bun:sqlite").Database) {
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
    CREATE TABLE substrate_issues (
      repo_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      title TEXT,
      body TEXT,
      state TEXT,
      priority INTEGER,
      issue_type TEXT,
      owner TEXT,
      labels TEXT,
      related_ids TEXT,
      parent_id TEXT,
      deleted_at TEXT,
      closed_at TEXT,
      close_reason TEXT,
      notes TEXT,
      runtime_kind TEXT,
      formula_name TEXT,
      template_name TEXT,
      contract_kind TEXT,
      contract_xml TEXT,
      metadata_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (repo_slug, issue_id)
    );
    CREATE TABLE substrate_dependencies (
      repo_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      dep_issue_id TEXT NOT NULL,
      relation TEXT NOT NULL
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
      specialist TEXT,
      last_output TEXT
    );
    CREATE TABLE materialization_state (
      source_key TEXT PRIMARY KEY,
      cursor TEXT,
      last_run_at DATETIME,
      last_success_at DATETIME,
      last_status TEXT,
      last_error TEXT
    );
    INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:gitboard', 'beads', '/tmp/gitboard/.beads', 'manual', 'active');
  `);
  return db;
}
