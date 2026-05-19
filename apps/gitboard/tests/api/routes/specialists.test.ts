import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";
import { createAttachPool } from "../../../src/server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../../src/server/observability/dao.ts";

type SeedRow = {
  beadId: string;
  chainId: string | null;
  epicId: string | null;
  chainKind: string | null;
  status: string;
  updatedAtMs: number;
};

type RepoSeed = {
  repoSlug: string;
  rows: SeedRow[];
  schemaOk?: boolean;
};

let dir: string;
let repos: RepoSeed[];
let openDbs: Database[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-specialists-"));
  repos = [
    {
      repoSlug: "repo-a",
      rows: [
        { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 1700000000000 },
        { beadId: "bead-2", chainId: "chain-1", epicId: "epic-1", chainKind: "reviewer", status: "running", updatedAtMs: 1700000002000 },
      ],
    },
    {
      repoSlug: "repo-b",
      rows: [
        { beadId: "bead-3", chainId: "chain-2", epicId: "epic-2", chainKind: "other", status: "running", updatedAtMs: 1700000003000 },
        { beadId: "bead-4", chainId: "chain-2", epicId: "epic-2", chainKind: "other", status: "closed", updatedAtMs: 1700000004000 },
        { beadId: "bead-1", chainId: "chain-4", epicId: "epic-4", chainKind: "executor", status: "done", updatedAtMs: 1700000005000 },
        { beadId: "bead-3", chainId: "chain-1", epicId: "epic-1", chainKind: "other", status: "running", updatedAtMs: 1700000006000 },
        { beadId: "bead-4", chainId: "chain-1", epicId: "epic-1", chainKind: "other", status: "running", updatedAtMs: 1700000007000 },
      ],
    },
  ];
  openDbs = repos.map((repo) => seedRepo(join(dir, `${repo.repoSlug}.db`), repo.rows, repo.schemaOk ?? true));
});

afterEach(async () => {
  for (const db of openDbs) db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/specialists/jobs", () => {
  it("returns seeded jobs with repo slug", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs?bead_id=bead-1"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: Array<Record<string, unknown>> };
    expect(json.jobs).toHaveLength(2);
    expect(json.jobs[0]).toEqual(expect.objectContaining({ repoSlug: "repo-b", beadId: "bead-1", chainId: "chain-4", epicId: "epic-4", chainKind: "executor", status: "done", updatedAt: "2023-11-14T22:13:25.000Z" }));
    expect(json.jobs[1]).toEqual(expect.objectContaining({ repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAt: "2023-11-14T22:13:20.000Z" }));
    for (const job of json.jobs) {
      expect(job).toHaveProperty("repoSlug");
      expect(typeof job.repoSlug).toBe("string");
    }
  });

  it("returns empty array for unknown bead_id", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs?bead_id=missing"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: unknown[] };
    expect(json.jobs).toEqual([]);
  });

  it("returns 400 when bead_id missing", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing bead_id" });
  });
});

describe("GET /api/specialists/jobs/in-flight", () => {
  it("returns 3 running rows ordered by updated_at_ms desc", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: Array<Record<string, unknown>>; epoch: Record<string, number> };
    expect(json.jobs.length).toBeGreaterThanOrEqual(3);
    const updates = json.jobs.map((job) => Date.parse(String(job.updatedAt)));
    for (let i = 1; i < updates.length; i += 1) {
      expect(updates[i - 1]).toBeGreaterThanOrEqual(updates[i]!);
    }
    expect(json.jobs.every((job) => typeof job.repoSlug === "string" && job.repoSlug.length > 0)).toBe(true);
    expect(json.epoch).toEqual({ "repo-a": 0, "repo-b": 0 });
  });

  it("returns empty jobs with epoch summary when repos attached but none running", async () => {
    const app = createAppWithDao([{ repoSlug: "repo-empty", rows: [{ beadId: "b", chainId: null, epicId: null, chainKind: null, status: "closed", updatedAtMs: 1 }] }]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: unknown[]; epoch: Record<string, number> };
    expect(json.jobs).toEqual([]);
    expect(json.epoch).toEqual({ "repo-empty": 0 });
    expect(Object.keys(json.epoch).length).toBeGreaterThan(0);
  });

  it("returns 200 with healthy data when one attached db is corrupt (skips bad repo)", async () => {
    const app = createAppWithDao([
      { repoSlug: "repo-a", rows: repos[0].rows },
      { repoSlug: "repo-corrupt", rows: [], schemaOk: false },
    ]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: Array<Record<string, unknown>>; epoch: Record<string, number> };
    expect(json.jobs.every((job) => job.repoSlug === "repo-a")).toBe(true);
  });
});

describe("GET /api/specialists/chains/:chain_id", () => {
  it("returns 4 jobs in chain_kind order", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/chain-1"));

    expect(res.status).toBe(200);
    const json = await res.json() as { chain: { jobs: Array<Record<string, unknown>> } };
    expect(json.chain.jobs).toHaveLength(4);
    expect(json.chain.jobs.every((job) => job.chainId === "chain-1")).toBe(true);
    expect(json.chain.jobs.map((job) => job.chainKind)).toEqual(["executor", "reviewer", "other", "other"]);
    for (const job of json.chain.jobs) {
      expect(job).toHaveProperty("repoSlug");
      expect(typeof job.repoSlug).toBe("string");
    }
  });

  it("returns 404 for unknown chain_id", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/missing"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chain not found" });
  });

  it("returns 200 with healthy chain data when one attached db is corrupt (skips bad repo)", async () => {
    const app = createAppWithDao([
      { repoSlug: "repo-a", rows: repos[0].rows },
      { repoSlug: "repo-corrupt", rows: [], schemaOk: false },
    ]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/chain-1"));

    expect(res.status).toBe(200);
    const json = await res.json() as { chain: { jobs: Array<Record<string, unknown>> } };
    expect(json.chain.jobs.every((job) => job.repoSlug === "repo-a")).toBe(true);
  });
});

function createAppWithDao(reposOverride: Array<{ repoSlug: string; rows: SeedRow[]; schemaOk?: boolean }> = repos): Hono {
  const pool = createAttachPool(reposOverride.map((repo) => ({
    repoSlug: repo.repoSlug,
    repoPath: join(dir, repo.repoSlug),
    dbPath: join(dir, `${repo.repoSlug}.db`),
    mtimeMs: 0,
  })));
  const dao = createObservabilityDao(pool);
  const app = new Hono();
  const listRepos = () => reposOverride.map((r) => ({ repoSlug: r.repoSlug }));
  const getEpoch = () => 0;
  app.route("/api/specialists", createSpecialistsRouter(dao, { listRepos, getEpoch }));
  return app;
}

function seedRepo(path: string, rows: SeedRow[], schemaOk: boolean): Database {
  const db = new Database(path, { create: true });
  if (schemaOk) {
    db.exec(`
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
    const insert = db.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    let counter = 0;
    for (const row of rows) { counter += 1; insert.run(`job-${counter}`, row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs, "explorer"); }
  }
  return db;
}

