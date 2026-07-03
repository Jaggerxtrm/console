import { describe, expect, it } from "vitest";
import {
  readSubstrateClosedIssues,
  readSubstrateIssueDependents,
  readSubstrateIssueDetail,
  readSubstrateIssues,
  readSubstrateRuntimeGraph,
  readSubstrateStats,
} from "../src/state/index.ts";

const itWithBunSqlite = "Bun" in globalThis ? it : it.skip;

describe("substrate read model", () => {
  itWithBunSqlite("returns an empty list when the database is null", () => {
    expect(readSubstrateIssues(null, "demo")).toEqual([]);
    expect(readSubstrateClosedIssues(null, "demo", 10)).toEqual([]);
    expect(readSubstrateIssueDetail(null, "demo", "x")).toBeNull();
    expect(readSubstrateIssueDependents(null, "demo", "x")).toEqual([]);
    expect(readSubstrateRuntimeGraph(null, "demo")).toEqual({ nodes: [], edges: [] });
    expect(readSubstrateStats(null, "demo")).toEqual({
      total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0,
      by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 },
      by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 },
    });
  });

  itWithBunSqlite("preserves opaque IDs and hydrates dependency metadata from substrate_issues", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, issue_type, priority, created_at, updated_at)
      VALUES
        ('demo', 'open-1', 'Open', NULL, 'open', 'task', 1, '2026-01-01', '2026-01-01'),
        ('demo', 'closed-1', 'Closed target', NULL, 'closed', 'bug', 2, '2026-01-01', '2026-01-01');
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at)
      VALUES ('demo', 'open-1', 'closed-1', 'blocks', '2026-01-01');
    `);

    const issues = readSubstrateIssues(db, "demo");
    expect(issues).toHaveLength(2);
    const open = issues.find((issue) => issue.id === "open-1")!;
    expect(open.dependencies).toEqual([
      expect.objectContaining({ id: "closed-1", title: "Closed target", status: "closed", issue_type: "bug", dependency_type: "blocks" }),
    ]);

    expect(readSubstrateIssueDetail(db, "demo", "open-1")?.id).toBe("open-1");
    expect(readSubstrateIssueDetail(db, "demo", "missing")).toBeNull();
  });

  itWithBunSqlite("orders closed issues by most recent close timestamp and applies the limit", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at, closed_at)
      VALUES
        ('demo', 'old', 'old', 'closed', 'task', 4, '2026-01-01', '2026-01-01', '2026-01-01'),
        ('demo', 'new', 'new', 'closed', 'task', 4, '2026-01-02', '2026-01-02', '2026-06-01'),
        ('demo', 'mid', 'mid', 'closed', 'task', 4, '2026-01-03', '2026-01-03', '2026-05-01');
    `);

    expect(readSubstrateClosedIssues(db, "demo", 2).map((issue) => issue.id)).toEqual(["new", "mid"]);
  });

  itWithBunSqlite("projects a runtime graph for chain molecules and steps", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, issue_type, priority, labels, parent_id, runtime_kind, formula_name, contract_kind, contract_xml, metadata_json, created_at, updated_at)
      VALUES
        ('demo', 'epic-1', 'Epic', NULL, 'open', 'epic', 1, '[]', NULL, 'organizational_epic', NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01'),
        ('demo', 'chain-1', 'Chain', '<change-contract><goal>X</goal></change-contract>', 'open', 'molecule', 1, '["formula:review-fix","kind:molecule"]', NULL, 'chain_molecule', 'review-fix', 'change-contract', '<change-contract><goal>X</goal></change-contract>', '{"metadata":{"k":"v"}}', '2026-01-01', '2026-01-01'),
        ('demo', 'chain-1.1', 'Step', '<step-contract/>', 'open', 'task', 2, '["kind:step"]', 'chain-1', 'step', NULL, 'step-contract', '<step-contract/>', NULL, '2026-01-01', '2026-01-01');
      INSERT INTO substrate_issue_edges (repo_slug, from_issue_id, to_issue_id, relation, created_at)
      VALUES
        ('demo', 'chain-1', 'epic-1', 'parent-child', '2026-01-01'),
        ('demo', 'chain-1.1', 'chain-1', 'parent-child', '2026-01-01'),
        ('demo', 'chain-1.1', 'chain-1', 'validates', '2026-01-01');
    `);

    const graph = readSubstrateRuntimeGraph(db, "demo");
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "epic-1", runtime_kind: "organizational_epic" }),
      expect.objectContaining({ id: "chain-1", runtime_kind: "chain_molecule", formula_name: "review-fix", contract_kind: "change-contract", metadata: { metadata: { k: "v" } } }),
      expect.objectContaining({ id: "chain-1.1", runtime_kind: "step", contract_kind: "step-contract" }),
    ]));
    expect(graph.edges).toEqual([
      { from: "chain-1", to: "epic-1", relation: "parent-child" },
      { from: "chain-1.1", to: "chain-1", relation: "parent-child" },
      { from: "chain-1.1", to: "chain-1", relation: "validates" },
    ]);
  });

  itWithBunSqlite("hydrates each dependent from its own issue row", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES
        ('demo', 'root', 'Root', 'open', 'task', 1, '2026-01-01', '2026-01-01'),
        ('demo', 'a', 'A', 'closed', 'bug', 2, '2026-01-01', '2026-01-01'),
        ('demo', 'b', 'B', 'open', 'feature', 2, '2026-01-01', '2026-01-01');
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at)
      VALUES
        ('demo', 'root', 'a', 'blocks', '2026-01-01'),
        ('demo', 'root', 'b', 'blocks', '2026-01-01');
    `);

    const dependents = readSubstrateIssueDependents(db, "demo", "a");
    expect(dependents).toEqual([
      expect.objectContaining({ id: "root", title: "Root", status: "open", issue_type: "task", dependency_type: "blocks" }),
    ]);
  });

  itWithBunSqlite("applies status, priority, search, and limit filters", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, issue_type, priority, labels, created_at, updated_at)
      VALUES
        ('demo', 'a', 'Alpha search', 'desc', 'open', 'task', 0, '[]', '2026-01-01', '2026-01-01'),
        ('demo', 'b', 'Bravo', 'desc', 'in_progress', 'task', 1, '[]', '2026-01-01', '2026-01-01'),
        ('demo', 'c', 'Charlie', 'desc', 'closed', 'task', 2, '[]', '2026-01-01', '2026-01-01');
    `);

    expect(readSubstrateIssues(db, "demo", { status: ["open"] }).map((issue) => issue.id)).toEqual(["a"]);
    expect(readSubstrateIssues(db, "demo", { priority: [0, 1] }).map((issue) => issue.id).sort()).toEqual(["a", "b"]);
    expect(readSubstrateIssues(db, "demo", { search: "search" }).map((issue) => issue.id)).toEqual(["a"]);
    expect(readSubstrateIssues(db, "demo", { limit: 2 })).toHaveLength(2);
    expect(readSubstrateIssues(db, "demo", { limit: 0 })).toHaveLength(3);
    expect(readSubstrateIssues(db, "demo", { issue_type: ["task"] })).toHaveLength(3);
  });

  itWithBunSqlite("normalizes JSON-quoted timestamp fields from substrate rows", async () => {
    const { Database } = await import("bun:sqlite");
    const db = createSubstrateDb(Database);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at, closed_at)
      VALUES ('demo', 'quoted', 'Quoted', 'closed', 'task', 2, '"2026-01-01T01:00:00.000Z"', '"2026-01-02T02:00:00.000Z"', '"2026-01-03T03:00:00.000Z"');
    `);

    expect(readSubstrateIssues(db, "demo", { limit: 0 })[0]).toEqual(expect.objectContaining({
      created_at: "2026-01-01T01:00:00.000Z",
      updated_at: "2026-01-02T02:00:00.000Z",
      closed_at: "2026-01-03T03:00:00.000Z",
    }));
  });
});

function createSubstrateDb(DatabaseCtor: typeof import("bun:sqlite").Database) {
  const db = new DatabaseCtor(":memory:");
  db.exec(`
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
      relation TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE substrate_issue_edges (
      repo_slug TEXT NOT NULL,
      from_issue_id TEXT NOT NULL,
      to_issue_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT
    );
  `);
  return db;
}
