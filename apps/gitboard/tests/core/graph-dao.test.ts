import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createGraphDao } from "../../src/core/graph-dao.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";

describe("createGraphDao xtrm source resolution", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-graph-dao-"));
    db = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves materialized beads projects by path basename as well as source id", () => {
    const projectId = "8ee0c958-2ec7-46d3-b842-f87669a746d0";
    const beadsPath = join(tmpDir, "specialists", ".beads");
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES (?, 'beads', ?, 'discovered', 'active')").run(`beads:${projectId}`, beadsPath);
    db.query("INSERT INTO materialization_state (source_key, last_status, last_success_at) VALUES (?, 'success', CURRENT_TIMESTAMP)").run(`beads:${projectId}`);
    db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type) VALUES (?, 'forge-child', 'child', 'open', 'task')").run(projectId);
    db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type) VALUES (?, 'forge-parent', 'parent', 'open', 'task')").run(projectId);
    db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation) VALUES (?, 'forge-child', 'forge-parent', 'blocks')").run(projectId);

    const result = createGraphDao({ xtrmDb: db }).getGraphSnapshot("specialists", true);

    expect(result.freshness).toBe("fresh");
    expect(result.graph.project_id).toBe(projectId);
    expect(result.graph.nodes.map((node) => node.id).sort()).toEqual(["forge-child", "forge-parent"]);
    expect(result.graph.edges).toEqual([{ from: "forge-child", to: "forge-parent", type: "blocks" }]);
  });
});
