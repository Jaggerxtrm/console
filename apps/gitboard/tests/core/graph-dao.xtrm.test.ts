import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { createGraphDao } from "../../src/core/graph-dao.ts";
import type { Database } from "bun:sqlite";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-graph-xtrm-"));
  db = createXtrmDatabase(join(dir, "xtrm.sqlite"));
  db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES ('beads:repo-a', 'beads', ?, 'discovered', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(join(dir, "repo-a", ".beads"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GraphDao xtrm source", () => {
  it("composes graph nodes, dependencies, live specialists, and health from xtrm.sqlite", () => {
    seedIssue("A", "Alpha", "open", 1, "task");
    seedIssue("B", "Beta", "blocked", 2, "bug");
    seedIssue("C", "Closed", "closed", 3, "feature");
    db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at) VALUES ('repo-a', 'A', 'B', 'blocks', CURRENT_TIMESTAMP)").run();
    db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at) VALUES ('repo-a', 'A', 'C', 'tracks', CURRENT_TIMESTAMP)").run();
    db.query("INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, specialist, status, chain_kind, updated_at) VALUES ('repo-a', 'job-1', 'A', 'executor', 'running', 'executor', '2026-01-01T00:00:00.000Z')").run();
    db.query("INSERT INTO specialist_jobs (repo_slug, job_id, bead_id, specialist, status, chain_kind, updated_at) VALUES ('repo-a', 'job-2', 'B', 'reviewer', 'done', 'reviewer', '2026-01-01T00:00:01.000Z')").run();
    db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status) VALUES ('beads:repo-a', CURRENT_TIMESTAMP, 'success')").run();

    const snapshot = createGraphDao({ xtrmDb: db }).getGraphSnapshot("repo-a");

    expect(snapshot.freshness).toBe("fresh");
    expect(snapshot.sourceHealth).toEqual(expect.objectContaining({ source: "graph", status: "fresh" }));
    expect(snapshot.graph.nodes.map((node) => node.id).sort()).toEqual(["A", "B"]);
    expect(snapshot.graph.nodes.find((node) => node.id === "C")).toBeUndefined();
    expect(snapshot.graph.edges).toEqual(expect.arrayContaining([{ from: "A", to: "B", type: "blocks" }]));
    expect(snapshot.graph.specialists).toEqual([expect.objectContaining({ bead_id: "A", job_id: "job-1", status: "running" })]);

    const includeClosed = createGraphDao({ xtrmDb: db }).getGraphSnapshot("repo-a", true);
    expect(includeClosed.graph.nodes.map((node) => node.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("keeps freshness from last success separate from degraded source health", () => {
    seedIssue("A", "Alpha", "open", 1, "task");
    db.query("INSERT INTO materialization_state (source_key, last_success_at, last_status, last_error) VALUES ('beads:repo-a', CURRENT_TIMESTAMP, 'error', 'source offline')").run();

    const snapshot = createGraphDao({ xtrmDb: db }).getGraphSnapshot("repo-a");

    expect(snapshot.freshness).toBe("fresh");
    expect(snapshot.graph.nodes.map((node) => node.id)).toEqual(["A"]);
    expect(snapshot.sourceHealth).toEqual(expect.objectContaining({ source: "graph", status: "degraded", message: "Graph source materialization failed." }));
    expect(snapshot.sourceHealth?.metadata).toEqual(expect.objectContaining({ last_status: "error", age_seconds: expect.any(Number) }));
    expect(snapshot.sourceHealth?.metadata).not.toHaveProperty("source_key");
  });
});

function seedIssue(issueId: string, title: string, state: string, priority: number, issueType: string): void {
  db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, priority, issue_type, created_at, updated_at) VALUES ('repo-a', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(issueId, title, state, priority, issueType);
}
