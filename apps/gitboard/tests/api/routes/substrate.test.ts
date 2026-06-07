import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createSubstrateRouter } from "../../../src/api/routes/substrate.ts";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";

describe("substrate projects", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gitboard-substrate-"));
    dbPath = join(tmpDir, "xtrm.sqlite");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("redacts raw beads path in project listing", async () => {
    const db = createXtrmDatabase(dbPath);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', '/very/private/workspace/demo/.beads', 'manual', 'active')").run();
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ path: string; beadsPath: string }> };
    expect(body.projects[0]?.path).not.toContain("/very/private/workspace/demo/.beads");
    expect(body.projects[0]?.beadsPath).not.toContain("/very/private/workspace/demo/.beads");

    db.close();
  });

  it("returns safe Dolt repair actions when port config is missing", async () => {
    const repoDir = join(tmpDir, "demo");
    const beadsDir = join(repoDir, ".beads");
    await mkdir(beadsDir, { recursive: true });
    await writeFile(join(beadsDir, "config.yaml"), "dolt:\n  shared-server: false\n");
    const db = createXtrmDatabase(dbPath);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', ?, 'manual', 'active')").run(beadsDir);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/repair-actions", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; actions: Array<{ id: string; available: boolean; command?: string; endpoint?: string }> };

    expect(body.status).toBe("jsonl_fallback");
    expect(body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rescan_source_health", available: true, endpoint: "/api/substrate/projects/demo/connection" }),
      expect.objectContaining({ id: "start_dolt_server", available: true }),
      expect.objectContaining({ id: "recover_port_config", available: true }),
    ]));
    expect(body.actions.find((action) => action.id === "start_dolt_server")?.command).toContain("bd -C");

    db.close();
  });

  it("marks dead Dolt pid files as repairable", async () => {
    const repoDir = join(tmpDir, "demo");
    const beadsDir = join(repoDir, ".beads");
    await mkdir(beadsDir, { recursive: true });
    await writeFile(join(beadsDir, "config.yaml"), "port: 65534\ndolt_database: demo\n");
    await writeFile(join(beadsDir, "dolt-server.pid"), "99999999\n");
    const db = createXtrmDatabase(dbPath);
    db.query("INSERT INTO sources (source_key, kind, path, origin, status) VALUES ('beads:demo', 'beads', ?, 'manual', 'active')").run(beadsDir);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/repair-actions", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; actions: Array<{ id: string; available: boolean; command?: string }> };

    expect(body.status).toBe("dolt_process_dead");
    expect(body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "restart_dolt_server", available: true }),
      expect.objectContaining({ id: "remove_dead_pid_file", available: true }),
    ]));
    expect(body.actions.find((action) => action.id === "remove_dead_pid_file")?.command).toContain("dolt-server.pid");

    db.close();
  });

  it("hydrates dependency metadata from substrate issues for closed targets", async () => {
    const db = createXtrmDatabase(dbPath);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES ('demo', 'open-1', 'Open issue', 'open', 'task', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at, closed_at)
      VALUES ('demo', 'closed-1', 'Closed target', 'closed', 'bug', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at)
      VALUES ('demo', 'open-1', 'closed-1', 'blocks', CURRENT_TIMESTAMP);
    `);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/open-1", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { issue: { dependencies: Array<{ id: string; title: string; status: string; issue_type?: string }> } };

    expect(body.issue.dependencies).toEqual([
      expect.objectContaining({ id: 'closed-1', title: 'Closed target', status: 'closed', issue_type: 'bug' }),
    ]);

    db.close();
  });
  it("hydrates each dependent from its own issue row", async () => {
    const db = createXtrmDatabase(dbPath);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at)
      VALUES
        ('demo', 'root-1', 'Root issue', 'open', 'task', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('demo', 'dep-1', 'First dependent', 'closed', 'bug', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('demo', 'dep-2', 'Second dependent', 'open', 'feature', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at)
      VALUES
        ('demo', 'root-1', 'dep-1', 'blocks', CURRENT_TIMESTAMP),
        ('demo', 'root-1', 'dep-2', 'blocks', CURRENT_TIMESTAMP);
    `);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/root-1", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { issue: { dependencies: Array<{ id: string; title: string; status: string; issue_type?: string }> } };

    expect(body.issue.dependencies).toEqual([
      expect.objectContaining({ id: 'dep-1', title: 'First dependent', status: 'closed', issue_type: 'bug' }),
      expect.objectContaining({ id: 'dep-2', title: 'Second dependent', status: 'open', issue_type: 'feature' }),
    ]);

    db.close();
  });

  it("orders closed issues by most recent close timestamp before applying the limit", async () => {
    const db = createXtrmDatabase(dbPath);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, state, issue_type, priority, created_at, updated_at, closed_at)
      VALUES
        ('demo', 'old-p0', 'Old P0', 'closed', 'task', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('demo', 'new-p4', 'New P4', 'closed', 'task', 4, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-06-01T00:00:00Z'),
        ('demo', 'middle-p1', 'Middle P1', 'closed', 'task', 1, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', '2026-05-01T00:00:00Z'),
        ('demo', 'open-new', 'Open New', 'open', 'task', 0, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z', NULL);
    `);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/issues/closed?limit=2", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { issues: Array<{ id: string }> };

    expect(body.issues.map((issue) => issue.id)).toEqual(["new-p4", "middle-p1"]);

    db.close();
  });

  it("serves a typed Beads runtime graph for chain molecules and steps", async () => {
    const db = createXtrmDatabase(dbPath);
    db.exec(`
      INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, issue_type, priority, labels, parent_id, runtime_kind, formula_name, contract_kind, contract_xml, metadata_json, created_at, updated_at)
      VALUES
        ('demo', 'epic-1', 'Org epic', 'north star', 'open', 'epic', 1, '[]', NULL, 'organizational_epic', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('demo', 'chain-1', 'Review chain', '<change-contract><goal>Ship telemetry</goal></change-contract>', 'open', 'molecule', 1, '["formula:review-fix","kind:molecule"]', NULL, 'chain_molecule', 'review-fix', 'change-contract', '<change-contract><goal>Ship telemetry</goal></change-contract>', '{"metadata":{"recommended_template":"review-fix"}}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('demo', 'chain-1.1', 'Reviewer', '<step-contract><role>reviewer</role></step-contract>', 'open', 'task', 2, '["kind:step","role:reviewer"]', 'chain-1', 'step', NULL, 'step-contract', '<step-contract><role>reviewer</role></step-contract>', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO substrate_issue_edges (repo_slug, from_issue_id, to_issue_id, relation, created_at)
      VALUES
        ('demo', 'chain-1', 'epic-1', 'parent-child', CURRENT_TIMESTAMP),
        ('demo', 'chain-1.1', 'chain-1', 'parent-child', CURRENT_TIMESTAMP),
        ('demo', 'chain-1.1', 'chain-1', 'validates', CURRENT_TIMESTAMP);
    `);
    const app = createSubstrateRouter(db);

    const response = await app.fetch(new Request("http://localhost/projects/demo/runtime-graph", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { nodes: Array<{ id: string; runtime_kind: string; formula_name?: string | null; contract_kind?: string | null; metadata?: unknown }>; edges: Array<{ from: string; to: string; relation: string }> };

    expect(body.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "epic-1", runtime_kind: "organizational_epic" }),
      expect.objectContaining({ id: "chain-1", runtime_kind: "chain_molecule", formula_name: "review-fix", contract_kind: "change-contract" }),
      expect.objectContaining({ id: "chain-1.1", runtime_kind: "step", contract_kind: "step-contract" }),
    ]));
    expect(body.edges).toEqual([
      { from: "chain-1", to: "epic-1", relation: "parent-child" },
      { from: "chain-1.1", to: "chain-1", relation: "parent-child" },
      { from: "chain-1.1", to: "chain-1", relation: "validates" },
    ]);

    db.close();
  });
});
