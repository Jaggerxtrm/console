import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createAttachPool } from "../../../src/server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../../src/server/observability/dao.ts";
import { createGraphDao } from "../../../src/core/graph-dao.ts";
import { createGraphRouter } from "../../../src/api/routes/graph.ts";
import { ProjectScanner } from "../../../src/core/project-scanner.ts";

let dir: string;
let obsDb: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-graph-"));
  await seedProject();
  obsDb = new Database(join(dir, "repo.db"), { create: true });
  obsDb.exec(`
    CREATE TABLE specialist_jobs (
      job_id TEXT PRIMARY KEY,
      bead_id TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      specialist TEXT
    );
  `);
  const insert = obsDb.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("job-1", "gitboard-1", "chain-1", null, "executor", "running", 1700000000000, "executor");
  insert.run("job-2", "gitboard-4", "chain-2", null, "reviewer", "waiting", 1700000001000, "reviewer");
  insert.run("job-3", "gitboard-5", "chain-3", null, "executor", "done", 1700000002000, "executor");
});

afterEach(async () => {
  obsDb.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/console/graph", () => {
  it("returns nodes, edges, specialists", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard&include_closed=false"));
    expect(res.status).toBe(200);
    const json = await res.json() as { project_id: string; repo_slug: string; nodes: Array<{ id: string }>; edges: Array<{ type: string }>; specialists: Array<{ bead_id: string; status: string }> };
    expect(json.project_id).toBe("gitboard");
    expect(json.repo_slug).toBe("gitboard");
    expect(json.nodes.map((node) => node.id).sort()).toEqual(["gitboard-1", "gitboard-2", "gitboard-4", "gitboard-5"].sort());
    expect(json.edges).toHaveLength(3);
    expect(new Set(json.edges.map((edge) => edge.type))).toEqual(new Set(["blocks", "related", "tracks"]));
    expect(json.specialists.map((job) => job.bead_id)).toEqual(["gitboard-4", "gitboard-1"]);
    expect(json.specialists[0]).toEqual(expect.objectContaining({ bead_id: "gitboard-4", status: "waiting" }));
    expect(json.specialists[1]).toEqual(expect.objectContaining({ bead_id: "gitboard-1", status: "running" }));
  });

  it("includes closed nodes when include_closed=true", async () => {
    const app = createApp();
    const openRes = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard&include_closed=false"));
    const openJson = await openRes.json() as { nodes: Array<{ id: string }> };
    const closedRes = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard&include_closed=true"));
    const closedJson = await closedRes.json() as { nodes: Array<{ id: string }> };

    expect(closedJson.nodes.length).toBeGreaterThan(openJson.nodes.length);
    expect(openJson.nodes.some((node) => node.id === "gitboard-4")).toBe(true);
    expect(closedJson.nodes.some((node) => node.id === "gitboard-6")).toBe(true);
  });

  it("reuses cached scan and issue data until explicit refresh", async () => {
    const scanner = new CountingScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git"] });
    const app = createApp(scanner);

    const firstRes = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard"));
    const first = await firstRes.json() as { nodes: Array<{ id: string }> };
    expect(first.nodes.some((node) => node.id === "gitboard-7")).toBe(false);

    await appendFile(join(dir, "gitboard", ".beads", "backup", "issues.jsonl"), `\n${JSON.stringify({ id: "gitboard-7", title: "G", description: null, status: "open", priority: 2, issue_type: "task", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null })}`);

    const cachedRes = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard"));
    const cached = await cachedRes.json() as { nodes: Array<{ id: string }> };
    expect(cached.nodes.some((node) => node.id === "gitboard-7")).toBe(false);
    expect(scanner.scanCount).toBe(1);

    const refreshedRes = await app.fetch(new Request("http://localhost/api/console/graph?project_id=gitboard&refresh=true"));
    const refreshed = await refreshedRes.json() as { nodes: Array<{ id: string }> };
    expect(refreshed.nodes.some((node) => node.id === "gitboard-7")).toBe(true);
    expect(scanner.scanCount).toBe(2);
  });
});

class CountingScanner extends ProjectScanner {
  scanCount = 0;

  override async scanDirectory() {
    this.scanCount += 1;
    return super.scanDirectory();
  }
}

function createApp(scanner = new ProjectScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git" ] })): Hono {
  const pool = createAttachPool([{ repoSlug: "gitboard", repoPath: dir, dbPath: join(dir, "repo.db"), mtimeMs: 0 }]);
  const dao = createGraphDao({ scanner, observability: createObservabilityDao(pool) });
  const app = new Hono();
  app.route("/api/console/graph", createGraphRouter(dao));
  return app;
}

async function seedProject(): Promise<void> {
  const beadsPath = join(dir, "gitboard", ".beads", "backup");
  await mkdir(beadsPath, { recursive: true });
  await writeFile(join(dir, "gitboard", ".beads", "metadata.json"), JSON.stringify({ project_id: "gitboard" }));
  await writeFile(join(beadsPath, "issues.jsonl"), [
    { id: "gitboard-1", title: "A", description: null, status: "open", priority: 1, issue_type: "task", owner: "alice", created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: "gitboard-2", title: "B", description: null, status: "open", priority: 2, issue_type: "bug", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: "gitboard-3", title: "C", description: null, status: "closed", priority: 3, issue_type: "feature", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z", close_reason: null },
    { id: "gitboard-4", title: "D", description: null, status: "closed", priority: 4, issue_type: "epic", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z", close_reason: null },
    { id: "gitboard-5", title: "E", description: null, status: "open", priority: 0, issue_type: "chore", owner: "bob", created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: "gitboard-6", title: "F", description: null, status: "closed", priority: 0, issue_type: "decision", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-03T00:00:00Z", close_reason: null },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(join(beadsPath, "dependencies.jsonl"), [
    { issue_id: "gitboard-1", depends_on_id: "gitboard-2", type: "blocks" },
    { issue_id: "gitboard-3", depends_on_id: "gitboard-4", type: "supersedes" },
    { issue_id: "gitboard-5", depends_on_id: "gitboard-1", type: "related" },
    { issue_id: "gitboard-2", depends_on_id: "gitboard-5", type: "tracks" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(join(beadsPath, "labels.jsonl"), "");
}
