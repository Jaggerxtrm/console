import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";
import { createAttachPool } from "../../../src/server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../../src/server/observability/dao.ts";
import { bump } from "../../../src/server/observability/epoch.ts";

let dir: string;
let repoA: Database;
let repoB: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-specialists-"));
  repoA = seedRepo(join(dir, "repo-a.db"), [
    { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 1700000000000 },
    { beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "executor", status: "running", updatedAtMs: 1700000003000 },
    { beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "reviewer", status: "running", updatedAtMs: 1700000005000 },
  ]);
  repoB = seedRepo(join(dir, "repo-b.db"), [
    { beadId: "bead-1", chainId: "chain-2", epicId: "epic-2", chainKind: "reviewer", status: "starting", updatedAtMs: 1700000001000 },
    { beadId: "bead-2", chainId: null, epicId: null, chainKind: null, status: "done", updatedAtMs: 1700000002000 },
    { beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "other", status: "running", updatedAtMs: 1700000004000 },
    { beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "other", status: "running", updatedAtMs: 1700000006000 },
  ]);
  bump("repo-a");
  bump("repo-b");
  bump("repo-b");
});

afterEach(async () => {
  repoA.close();
  repoB.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/specialists/jobs", () => {
  it("returns seeded jobs with repo slug", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs?bead_id=bead-1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [
        {
          repoSlug: "repo-a",
          beadId: "bead-1",
          chainId: "chain-1",
          epicId: "epic-1",
          chainKind: "executor",
          status: "running",
          updatedAt: "2023-11-14T22:13:20.000Z",
        },
        {
          repoSlug: "repo-b",
          beadId: "bead-1",
          chainId: "chain-2",
          epicId: "epic-2",
          chainKind: "reviewer",
          status: "starting",
          updatedAt: "2023-11-14T22:13:21.000Z",
        },
      ],
    });
  });

  it("returns in-flight jobs with epoch field", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [
        {
          repoSlug: "repo-b",
          beadId: "bead-3",
          chainId: "chain-3",
          epicId: "epic-3",
          chainKind: "other",
          status: "running",
          updatedAt: "2023-11-14T22:13:26.000Z",
        },
        {
          repoSlug: "repo-b",
          beadId: "bead-3",
          chainId: "chain-3",
          epicId: "epic-3",
          chainKind: "other",
          status: "running",
          updatedAt: "2023-11-14T22:13:24.000Z",
        },
        {
          repoSlug: "repo-a",
          beadId: "bead-3",
          chainId: "chain-3",
          epicId: "epic-3",
          chainKind: "reviewer",
          status: "running",
          updatedAt: "2023-11-14T22:13:25.000Z",
        },
        {
          repoSlug: "repo-a",
          beadId: "bead-1",
          chainId: "chain-1",
          epicId: "epic-1",
          chainKind: "executor",
          status: "running",
          updatedAt: "2023-11-14T22:13:20.000Z",
        },
        {
          repoSlug: "repo-b",
          beadId: "bead-1",
          chainId: "chain-2",
          epicId: "epic-2",
          chainKind: "reviewer",
          status: "starting",
          updatedAt: "2023-11-14T22:13:21.000Z",
        },
      ],
      epoch: { "repo-a": 1, "repo-b": 2 },
    });
  });

  it("returns zero epoch for attached repos with no in-flight rows", async () => {
    const app = createAppWithDao([{ repoSlug: "repo-b", dbPath: join(dir, "repo-b.db") }]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [], epoch: { "repo-b": 2 } });
  });

  it("returns empty list for unknown bead_id", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs?bead_id=missing"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [] });
  });

  it("returns 400 when bead_id missing", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing bead_id" });
  });
});

describe("GET /api/specialists/chains/:chain_id", () => {
  it("returns ordered chain", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/chain-3"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chain: {
        jobs: [
          {
            repoSlug: "repo-a",
            beadId: "bead-3",
            chainId: "chain-3",
            epicId: "epic-3",
            chainKind: "executor",
            status: "running",
            updatedAt: "2023-11-14T22:13:23.000Z",
          },
          {
            repoSlug: "repo-a",
            beadId: "bead-3",
            chainId: "chain-3",
            epicId: "epic-3",
            chainKind: "reviewer",
            status: "running",
            updatedAt: "2023-11-14T22:13:25.000Z",
          },
          {
            repoSlug: "repo-b",
            beadId: "bead-3",
            chainId: "chain-3",
            epicId: "epic-3",
            chainKind: "other",
            status: "running",
            updatedAt: "2023-11-14T22:13:24.000Z",
          },
          {
            repoSlug: "repo-b",
            beadId: "bead-3",
            chainId: "chain-3",
            epicId: "epic-3",
            chainKind: "other",
            status: "running",
            updatedAt: "2023-11-14T22:13:26.000Z",
          },
        ],
      },
    });
  });

  it("returns 404 for unknown chain", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/missing"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chain not found" });
  });
});

function createAppWithDao(repos: Array<{ repoSlug: string; dbPath: string }> = [
  { repoSlug: "repo-a", dbPath: join(dir, "repo-a.db") },
  { repoSlug: "repo-b", dbPath: join(dir, "repo-b.db") },
]): Hono {
  const pool = createAttachPool(repos.map((repo) => ({
    repoSlug: repo.repoSlug,
    repoPath: join(dir, repo.repoSlug),
    dbPath: repo.dbPath,
    mtimeMs: 0,
  })));
  const dao = createObservabilityDao(pool);
  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter(dao));
  return app;
}

function seedRepo(path: string, rows: Array<{ beadId: string; chainId: string | null; epicId: string | null; chainKind: string | null; status: string; updatedAtMs: number }>): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE specialist_jobs (
      bead_id TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    PRAGMA schema_version = 1;
  `);
  const insert = db.prepare("INSERT INTO specialist_jobs (bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs);
  return db;
}
