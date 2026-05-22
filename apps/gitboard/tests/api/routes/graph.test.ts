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
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";
import { ProjectScanner } from "../../../src/core/project-scanner.ts";
import type { BeadsProject } from "../../../src/types/beads.ts";

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
    const res = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&include_closed=false"));
    expect(res.status).toBe(200);
    const json = await res.json() as { project_id: string; repo_slug: string; freshness: string; source_health: { source: string; status: string }; nodes: Array<{ id: string }>; edges: Array<{ type: string }>; specialists: Array<{ bead_id: string; status: string }> };
    expect(json.project_id).toBe("gitboard");
    expect(json.repo_slug).toBe("gitboard");
    expect(json.freshness).toBe("fresh");
    expect(json.source_health).toEqual(expect.objectContaining({ source: "graph", status: "fresh" }));
    expect(json.nodes.map((node) => node.id).sort()).toEqual(["gitboard-1", "gitboard-2", "gitboard-4", "gitboard-5"].sort());
    expect(json.edges).toHaveLength(3);
    expect(new Set(json.edges.map((edge) => edge.type))).toEqual(new Set(["blocks", "related", "tracks"]));
    expect(json.specialists.map((job) => job.bead_id)).toEqual(["gitboard-4", "gitboard-1"]);
    expect(json.specialists[0]).toEqual(expect.objectContaining({ bead_id: "gitboard-4", status: "waiting" }));
    expect(json.specialists[1]).toEqual(expect.objectContaining({ bead_id: "gitboard-1", status: "running" }));
  });

  it("includes closed nodes when include_closed=true", async () => {
    const app = createApp();
    const openRes = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&include_closed=false"));
    const openJson = await openRes.json() as { nodes: Array<{ id: string }> };
    const closedRes = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&include_closed=true"));
    const closedJson = await closedRes.json() as { nodes: Array<{ id: string }> };

    expect(closedJson.nodes.length).toBeGreaterThan(openJson.nodes.length);
    expect(openJson.nodes.some((node) => node.id === "gitboard-4")).toBe(true);
    expect(closedJson.nodes.some((node) => node.id === "gitboard-6")).toBe(true);
  });

  it("reuses cached scan and issue data until explicit refresh", async () => {
    const scanner = new CountingScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git"] });
    const app = createApp(scanner);

    const firstRes = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard"));
    const first = await firstRes.json() as { nodes: Array<{ id: string }> };
    expect(first.nodes.some((node) => node.id === "gitboard-7")).toBe(false);

    await appendFile(join(dir, "gitboard", ".beads", "backup", "issues.jsonl"), `\n${JSON.stringify({ id: "gitboard-7", title: "G", description: null, status: "open", priority: 2, issue_type: "task", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null })}`);

    const cachedRes = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard"));
    const cached = await cachedRes.json() as { nodes: Array<{ id: string }> };
    expect(cached.nodes.some((node) => node.id === "gitboard-7")).toBe(false);
    expect(scanner.scanCount).toBe(1);

    const refreshedRes = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&refresh=true"));
    const refreshed = await refreshedRes.json() as { nodes: Array<{ id: string }> };
    expect(refreshed.nodes.some((node) => node.id === "gitboard-7")).toBe(true);
    expect(scanner.scanCount).toBe(2);
  });

  it("does not reuse an in-flight scan for explicit refresh", async () => {
    const scanner = new DelayedScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git"] });
    const app = createApp(scanner);

    const first = app.fetch(new Request("http://localhost/api/console/graph?project=gitboard"));
    await scanner.waitForScanStart();
    const refreshed = app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&refresh=true"));

    scanner.releaseNextScan();
    await scanner.waitForScanStart(2);
    scanner.releaseNextScan();

    await first;
    await refreshed;
    expect(scanner.scanCount).toBe(2);
  });

  it("keeps unrelated project issue caches warm on project-scoped refresh", async () => {
    await seedProject("sideboard");
    const scanner = new CountingScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git"] });
    const app = createApp(scanner);

    await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard"));
    const sideInitialRes = await app.fetch(new Request("http://localhost/api/console/graph?project=sideboard"));
    const sideInitial = await sideInitialRes.json() as { nodes: Array<{ id: string }> };
    expect(sideInitial.nodes.some((node) => node.id === "sideboard-7")).toBe(false);

    await appendFile(join(dir, "sideboard", ".beads", "backup", "issues.jsonl"), `\n${JSON.stringify({ id: "sideboard-7", title: "Side", description: null, status: "open", priority: 2, issue_type: "task", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null })}`);

    await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&refresh=true"));
    const sideCachedRes = await app.fetch(new Request("http://localhost/api/console/graph?project=sideboard"));
    const sideCached = await sideCachedRes.json() as { nodes: Array<{ id: string }> };
    expect(sideCached.nodes.some((node) => node.id === "sideboard-7")).toBe(false);
  });

  it("keeps graph fast while specialists background refresh runs", async () => {
    const app = createColdParallelApp();
    const specialistsRequest = app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedAt = performance.now();
    const graphResponse = await app.fetch(new Request("http://localhost/api/console/graph?project=gitboard&include_closed=false"));
    const graphMs = performance.now() - startedAt;

    expect(graphResponse.status).toBe(200);
    expect(graphMs).toBeLessThan(300);

    const specialistsResponse = await specialistsRequest;
    expect(specialistsResponse.status).toBe(200);
  });
});

class CountingScanner extends ProjectScanner {
  scanCount = 0;

  override async scanDirectory() {
    this.scanCount += 1;
    return super.scanDirectory();
  }
}

class DelayedScanner extends CountingScanner {
  private waiters: Array<() => void> = [];
  private scanStarters: Array<() => void> = [];

  waitForScanStart(count = 1): Promise<void> {
    if (this.scanCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.scanStarters.push(resolve));
  }

  releaseNextScan(): void {
    this.waiters.shift()?.();
  }

  override async scanDirectory(): Promise<BeadsProject[]> {
    this.scanCount += 1;
    this.scanStarters.splice(0).forEach((resolve) => resolve());
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return ProjectScanner.prototype.scanDirectory.call(this) as Promise<BeadsProject[]>;
  }
}

function createApp(scanner = new ProjectScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git" ] })): Hono {
  const pool = createAttachPool([{ repoSlug: "gitboard", repoPath: dir, dbPath: join(dir, "repo.db"), mtimeMs: 0 }]);
  const dao = createGraphDao({ scanner, observability: createObservabilityDao(pool) });
  const app = new Hono();
  app.route("/api/console/graph", createGraphRouter(dao));
  return app;
}

function createColdParallelApp(): Hono {
  const repos = Array.from({ length: 30 }, (_, index) => {
    const repoSlug = `cold-${index}`;
    const dbPath = join(dir, `${repoSlug}.db`);
    const db = new Database(dbPath, { create: true });
    db.exec(`CREATE TABLE specialist_jobs (job_id TEXT PRIMARY KEY, bead_id TEXT NOT NULL, chain_id TEXT, epic_id TEXT, chain_kind TEXT, status TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, specialist TEXT);`);
    db.close();
    return { repoSlug, repoPath: join(dir, repoSlug), dbPath, mtimeMs: 0 };
  });
  const pool = createAttachPool(repos);
  const observability = createObservabilityDao(pool);
  const scanner = new ProjectScanner({ searchPath: dir, maxDepth: 2, excludePatterns: ["node_modules", ".git"] });
  const app = new Hono();
  app.route("/api/console/graph", createGraphRouter(createGraphDao({ scanner, observability })));
  app.route("/api/specialists", createSpecialistsRouter(observability, { listRepos: () => repos, getEpoch: () => 0 }));
  return app;
}

async function seedProject(projectId = "gitboard"): Promise<void> {
  const beadsPath = join(dir, projectId, ".beads", "backup");
  await mkdir(beadsPath, { recursive: true });
  await writeFile(join(dir, projectId, ".beads", "metadata.json"), JSON.stringify({ project_id: projectId }));
  await writeFile(join(beadsPath, "issues.jsonl"), [
    { id: `${projectId}-1`, title: "A", description: null, status: "open", priority: 1, issue_type: "task", owner: "alice", created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: `${projectId}-2`, title: "B", description: null, status: "open", priority: 2, issue_type: "bug", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: `${projectId}-3`, title: "C", description: null, status: "closed", priority: 3, issue_type: "feature", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z", close_reason: null },
    { id: `${projectId}-4`, title: "D", description: null, status: "closed", priority: 4, issue_type: "epic", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-02T00:00:00Z", close_reason: null },
    { id: `${projectId}-5`, title: "E", description: null, status: "open", priority: 0, issue_type: "chore", owner: "bob", created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: null, close_reason: null },
    { id: `${projectId}-6`, title: "F", description: null, status: "closed", priority: 0, issue_type: "decision", owner: null, created_at: "2026-01-01T00:00:00Z", created_by: null, updated_at: "2026-01-01T00:00:00Z", closed_at: "2026-01-03T00:00:00Z", close_reason: null },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(join(beadsPath, "dependencies.jsonl"), [
    { issue_id: `${projectId}-1`, depends_on_id: `${projectId}-2`, type: "blocks" },
    { issue_id: `${projectId}-3`, depends_on_id: `${projectId}-4`, type: "supersedes" },
    { issue_id: `${projectId}-5`, depends_on_id: `${projectId}-1`, type: "related" },
    { issue_id: `${projectId}-2`, depends_on_id: `${projectId}-5`, type: "tracks" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(join(beadsPath, "labels.jsonl"), "");
}
