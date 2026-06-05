import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createApp } from "../../../src/api/server.ts";
import { createSpecialistsRouter } from "../../../src/api/routes/specialists.ts";
import { jobFeedState } from "../../../src/dashboard/components/specialists/beadActivityState.ts";
import { __resetObservabilityRegistryForTests } from "../../../src/server/observability/registry.ts";
import { createAttachPool } from "../../../src/server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../../src/server/observability/dao.ts";
import type { SpecialistJob } from "../../../src/server/observability/types.ts";

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
  process.env.GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN = "test-admin-token";
  __resetObservabilityRegistryForTests();
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
  delete process.env.GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN;
  for (const db of openDbs) db.close();
  await rm(dir, { recursive: true, force: true });
  __resetObservabilityRegistryForTests();
});

describe("GET /api/specialists/jobs", () => {
  it("returns seeded jobs with repo slug", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs?bead_id=bead-1"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: Array<Record<string, unknown>>; source_health: { source: string; status: string } };
    expect(json.jobs).toHaveLength(2);
    expect(json.source_health).toEqual(expect.objectContaining({ source: "specialists", status: "fresh" }));
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
    const json = await res.json() as { jobs: Array<Record<string, unknown>>; recent_history: Array<Record<string, unknown>>; epoch: Record<string, number> };
    expect(json.jobs.length).toBeGreaterThanOrEqual(3);
    const updates = json.jobs.map((job) => Date.parse(String(job.updatedAt)));
    for (let i = 1; i < updates.length; i += 1) {
      expect(updates[i - 1]).toBeGreaterThanOrEqual(updates[i]!);
    }
    expect(json.jobs.every((job) => typeof job.repoSlug === "string" && job.repoSlug.length > 0)).toBe(true);
    expect(json.epoch).toEqual({ "repo-a": 0, "repo-b": 0 });
  });

  it("includes failed jobs in recent history for traceability", async () => {
    const failedDb = seedRepo(join(dir, "repo-failed.db"), [
      { beadId: "failed-bead", chainId: "chain-failed", epicId: "epic-failed", chainKind: "reviewer", status: "failed", updatedAtMs: 1700000010000 },
    ], true);
    openDbs.push(failedDb);
    const app = createAppWithDao([
      { repoSlug: "repo-failed", rows: [] },
    ]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?limit=52"));

    expect(res.status).toBe(200);
    const json = await res.json() as { recent_history: Array<Record<string, unknown>> };
    expect(json.recent_history).toEqual([
      expect.objectContaining({ beadId: "failed-bead", chainId: "chain-failed", status: "failed" }),
    ]);
  });

  it("filters by repo before applying the history limit", async () => {
    openDbs[0]!.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("job-history-a", "bead-history-a", "chain-history-a", null, "executor", "done", 1700000001000, "executor");
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight?limit=1&repo_slug=repo-a"));

    expect(res.status).toBe(200);
    const json = await res.json() as { jobs: Array<Record<string, unknown>>; recent_history: Array<Record<string, unknown>> };
    expect(json.jobs.every((job) => job.repoSlug === "repo-a")).toBe(true);
    expect(json.recent_history).toEqual([
      expect.objectContaining({ repoSlug: "repo-a", jobId: "job-history-a", beadId: "bead-history-a", status: "done" }),
    ]);
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

  it.skip("returns coverage for more than 10 discovered observability dbs", async () => {
    const manyRepos = Array.from({ length: 11 }, (_, index) => ({
      repoSlug: `repo-${index}`,
      rows: [{ beadId: `bead-${index}`, chainId: null, epicId: null, chainKind: null, status: "running", updatedAtMs: 1700000010000 + index }],
    }));
    const app = createAppWithDao(manyRepos);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));

    expect(res.status).toBe(200);
    const json = await res.json() as { coverage?: { attached: string[]; skipped: Array<{ slug: string; reason: string }>; totalDiscovered: number }; source_health: { status: string } };
    expect(json.coverage?.totalDiscovered).toBe(11);
    expect((json.coverage?.attached.length ?? 0) + (json.coverage?.skipped.length ?? 0)).toBe(11);
    expect(json.coverage?.skipped.length).toBeGreaterThan(0);
    expect(json.source_health.status).toBe("degraded");
  });

  it("reuses cached live summaries until repo epoch changes", async () => {
    let epoch = 0;
    let inFlightCalls = 0;
    let recentCalls = 0;
    const job = specialistJob({ beadId: "bead-live", status: "running" });
    const app = new Hono();
    app.route("/api/specialists", createSpecialistsRouter({
      jobsByBead: () => [],
      inFlightJobs: () => { inFlightCalls += 1; return [job]; },
      recentJobs: () => { recentCalls += 1; return []; },
      chainById: () => [],
    }, { listRepos: () => [{ repoSlug: "repo-a", repoPath: join(dir, "repo-a"), dbPath: join(dir, "repo-a.db"), mtimeMs: 0 }], getEpoch: () => epoch }));

    await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    expect(inFlightCalls).toBe(1);
    expect(recentCalls).toBe(1);

    epoch += 1;
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/in-flight"));
    const json = await res.json() as { epoch: Record<string, number> };
    expect(json.epoch).toEqual({ "repo-a": 1 });
    expect(inFlightCalls).toBe(2);
    expect(recentCalls).toBe(2);
  });
});

describe("BeadActivityPane job branch helper", () => {
  it("maps running to mounted stream and completed to collapsed", () => {
    const running = specialistJob({ status: "running" });
    const done = specialistJob({ status: "done" });
    expect(jobFeedState(running, false)).toBe("running");
    expect(jobFeedState(done, false)).toBe("collapsed");
    expect(jobFeedState(done, true)).toBe("expanded");
  });
});

describe("GET /api/specialists/jobs/:job_id/result", () => {
  it("returns 403 for non-admin", async () => {
    const app = createResultApp();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/result"));
    expect(res.status).toBe(403);
  });

  it("returns markdown result for admin", async () => {
    const app = createResultApp(true);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/result", { headers: { "x-gitboard-shell-token": "test-admin-token" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "# done", content_type: "text/markdown" });
  });

  it("returns markdown result for same-origin dashboard reads", async () => {
    const app = createResultApp(true);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/result", { headers: { "sec-fetch-site": "same-origin" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "# done", content_type: "text/markdown" });
  });
});

describe("GET /api/specialists/jobs/:job_id/feed-events", () => {
  it("returns forensic events for resolved repo only", async () => {
    const app = createResultApp(true);
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/feed-events", { headers: { "x-gitboard-shell-token": "test-admin-token" } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [
      expect.objectContaining({ schema_version: "xtrm.forensic.v1", event_family: "job", event_name: "job.started", seq: 1, body: { mode: "test" } }),
      expect.objectContaining({ schema_version: "xtrm.forensic.v1", event_family: "job", event_name: "job.completed", seq: 2, body: { elapsed_ms: 15 } }),
    ] });
  });

  it("returns 404 when job cannot be resolved to a repo", async () => {
    const app = createUnresolvedFeedEventsApp();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-missing/feed-events", { headers: { "x-gitboard-shell-token": "test-admin-token" } }));

    expect(res.status).toBe(404);
  });

  it("preserves canonical envelope fields while dropping unknown top-level keys", async () => {
    const app = createResultApp(true, { extraPayload: true });
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/feed-events", { headers: { "x-gitboard-shell-token": "test-admin-token" } }));

    expect(res.status).toBe(200);
    const json = await res.json() as { events: Array<Record<string, unknown>> };
    expect(json.events[0]).toMatchObject({ event_name: "job.started", body: { mode: "test" }, trace: { trace_id: "trace-1" }, links: { dashboard: "/console" } });
    expect(json.events[0]).not.toHaveProperty("secret");
  });
});

describe("GET /api/specialists/jobs/:job_id/feed", () => {
  it("returns 403 for non-admin", async () => {
    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/feed"));
    expect(res.status).toBe(403);
  });

  it("returns terminal feed for admin", async () => {
    for (const repoSlug of ["repo-a", "repo-b"]) {
      const repoDir = join(dir, repoSlug);
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, "feed"), `printf '%s\\n' "JOB:$1"`);
      chmodSync(join(repoDir, "feed"), 0o755);
    }
    process.env.GITBOARD_SPECIALISTS_BIN = "/bin/sh";

    const app = createAppWithDao();
    const res = await app.fetch(new Request("http://localhost/api/specialists/jobs/job-1/feed", { headers: { "x-gitboard-shell-token": "test-admin-token" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "JOB:job-1\n", content_type: "text/plain; charset=utf-8" });
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

  it("returns standalone job history by job id when chain_id is missing", async () => {
    const standaloneDb = seedRepo(join(dir, "repo-standalone.db"), [
      { beadId: "bead-standalone", chainId: null, epicId: null, chainKind: "executor", status: "done", updatedAtMs: 1700000020000 },
    ], true);
    openDbs.push(standaloneDb);
    const app = createAppWithDao([{ repoSlug: "repo-standalone", rows: [] }]);
    const res = await app.fetch(new Request("http://localhost/api/specialists/chains/job-1"));

    expect(res.status).toBe(200);
    const json = await res.json() as { chain: { jobs: Array<Record<string, unknown>> } };
    expect(json.chain.jobs).toEqual([
      expect.objectContaining({ jobId: "job-1", beadId: "bead-standalone", chainId: null, status: "done" }),
    ]);
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

describe("createApp cold-start materializer", () => {
  it.skip("triggers initial observability materialization on boot", async () => {
    const rootsDir = await mkdtemp(join(tmpdir(), "gitboard-obs-root-"));
    const repoDir = join(rootsDir, "repo-one");
    await Bun.write(join(repoDir, ".keep"), "");
    const obsDb = new Database(join(repoDir, "observability.db"), { create: true });
    obsDb.exec(`
      CREATE TABLE specialist_jobs (
        job_id TEXT PRIMARY KEY,
        specialist TEXT NOT NULL,
        worktree_column TEXT,
        bead_id TEXT,
        node_id TEXT,
        status TEXT NOT NULL,
        status_json TEXT NOT NULL DEFAULT '{}',
        updated_at_ms INTEGER NOT NULL,
        last_output TEXT,
        startup_payload_json TEXT,
        chain_id TEXT,
        epic_id TEXT,
        chain_kind TEXT NOT NULL DEFAULT 'prep',
        chain_root_job_id TEXT,
        chain_root_bead_id TEXT
      );
      CREATE TABLE specialist_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        seq INTEGER,
        specialist TEXT,
        bead_id TEXT,
        t INTEGER,
        type TEXT,
        event_json TEXT
      );
      INSERT INTO specialist_jobs (job_id, specialist, status, updated_at_ms) VALUES ('job-1', 'explorer', 'running', 1);
      CREATE TABLE materialization_state (
        source_key TEXT PRIMARY KEY,
        cursor TEXT,
        last_run_at DATETIME,
        last_success_at DATETIME,
        last_status TEXT,
        last_error TEXT
      );
    `);
    obsDb.close();
    process.env.OBSERVABILITY_ROOTS = rootsDir;

    const xtrmDb = new Database(":memory:");
    xtrmDb.exec(`
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
      CREATE TABLE specialist_jobs (
        repo_slug TEXT NOT NULL,
        job_id TEXT NOT NULL,
        specialist TEXT,
        status TEXT NOT NULL,
        chain_id TEXT,
        epic_id TEXT,
        chain_kind TEXT,
        worktree TEXT,
        last_output TEXT,
        created_at TEXT,
        updated_at TEXT,
        updated_at_ms INTEGER,
        PRIMARY KEY (repo_slug, job_id)
      );
    `);

    createApp(new Database(":memory:"), xtrmDb);
    await new Promise((resolve) => setTimeout(resolve, 1700));

    const row = xtrmDb.query("SELECT last_status, source_key FROM materialization_state WHERE source_key = ?").get("obs:repo-one") as { last_status: string; source_key: string } | undefined;
    expect(row).toEqual({ source_key: "obs:repo-one", last_status: "success" });

    xtrmDb.close();
    await rm(rootsDir, { recursive: true, force: true });
    delete process.env.OBSERVABILITY_ROOTS;
  });
});

function createSpecialistsHybridApp(success = false): Hono {
  const xtrmDb = new Database(":memory:");
  xtrmDb.exec(`
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
    CREATE TABLE materialization_state (
      source_key TEXT PRIMARY KEY,
      cursor TEXT,
      last_run_at DATETIME,
      last_success_at DATETIME,
      last_status TEXT,
      last_error TEXT
    );
  `);
  xtrmDb.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("job-xtrm", "bead-xtrm", null, null, null, "running", 1, "explorer");
  if (success) xtrmDb.query("INSERT INTO materialization_state (source_key, last_status, last_success_at) VALUES (?, 'success', CURRENT_TIMESTAMP)").run("obs:repo-xtrm");

  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter(undefined, xtrmDb, {
    listRepos: () => [{ repoSlug: "repo-a", repoPath: join(dir, "repo-a"), dbPath: join(dir, "repo-a.db"), mtimeMs: 0 }],
    getEpoch: () => 0,
  }));
  return app;
}

function specialistJob(overrides: Partial<Record<"beadId" | "status", string>> = {}) {
  return {
    jobId: "job-live",
    repoSlug: "repo-a",
    beadId: overrides.beadId ?? "bead-1",
    chainId: null,
    epicId: null,
    chainKind: null,
    status: overrides.status ?? "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    specialist: "executor",
    lastOutput: null,
    turns: null,
    tools: null,
    model: null,
  };
}

function createAppWithDao(reposOverride: Array<{ repoSlug: string; rows: SeedRow[]; schemaOk?: boolean }> = repos): Hono {
  const pool = createAttachPool(reposOverride.map((repo) => ({
    repoSlug: repo.repoSlug,
    repoPath: join(dir, repo.repoSlug),
    dbPath: join(dir, `${repo.repoSlug}.db`),
    mtimeMs: 0,
  })));
  const dao = createObservabilityDao(pool);
  const app = new Hono();
  const listRepos = () => reposOverride.map((r) => ({ repoSlug: r.repoSlug, repoPath: join(dir, r.repoSlug), dbPath: join(dir, `${r.repoSlug}.db`), mtimeMs: 0 }));
  const getEpoch = () => 0;
  app.route("/api/specialists", createSpecialistsRouter(dao, { listRepos, getEpoch }));
  return app;
}

function createResultApp(_success = false, options: { extraPayload?: boolean } = {}): Hono {
  const xtrmDb = new Database(":memory:");
  xtrmDb.exec(`
    CREATE TABLE specialist_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE xtrm_forensic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT,
      t_unix_ms INTEGER,
      seq INTEGER,
      envelope_json TEXT
    );
  `);
  xtrmDb.prepare("INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", "result", "# done", "2026-01-01T00:00:00.000Z");
  xtrmDb.prepare("INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", "forensic_event", JSON.stringify(eventPayload(options.extraPayload)), "2026-01-01T00:00:01.000Z");
  xtrmDb.prepare("INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run("repo-b", "job-1", "forensic_event", JSON.stringify({ schema_version: 9, event_family: "mix", event_name: "other" }), "2026-01-01T00:00:02.000Z");
  xtrmDb.prepare("INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", 20, 2, JSON.stringify(forensicEnvelope("job.completed", 2, { elapsed_ms: 15 }, options.extraPayload)));
  xtrmDb.prepare("INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES (?, ?, ?, ?, ?)").run("repo-a", "job-1", 10, 1, JSON.stringify(forensicEnvelope("job.started", 1, { mode: "test" }, options.extraPayload)));
  xtrmDb.prepare("INSERT INTO xtrm_forensic_events (repo_slug, job_id, t_unix_ms, seq, envelope_json) VALUES (?, ?, ?, ?, ?)").run("repo-b", "job-1", 5, 1, JSON.stringify(forensicEnvelope("job.started", 1, { mode: "wrong-repo" })));
  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter({
    jobsByBead: () => [],
    inFlightJobs: () => [resolvedJob()],
    recentJobs: () => [resolvedJob()],
    chainById: () => [],
  }, xtrmDb, { listRepos: () => [{ repoSlug: "repo-a", repoPath: join(dir, "repo-a"), dbPath: join(dir, "repo-a.db"), mtimeMs: 0 }, { repoSlug: "repo-b", repoPath: join(dir, "repo-b"), dbPath: join(dir, "repo-b.db"), mtimeMs: 0 }], getEpoch: () => 0 }));
  return app;
}

function forensicEnvelope(eventName: string, seq: number, body: Record<string, unknown>, extraPayload = false): Record<string, unknown> {
  return {
    schema_version: "xtrm.forensic.v1",
    timestamp: `2026-01-01T00:00:0${seq}.000Z`,
    t_unix_ms: seq * 10,
    seq,
    severity: "info",
    event_family: eventName.split(".")[0],
    event_name: eventName,
    event_version: 1,
    resource: { participant_kind: "specialist", participant_role: "executor" },
    correlation: { job_id: "job-1", trace_id: "trace-1" },
    body,
    redaction: { status: "clean" },
    trace: extraPayload ? { trace_id: "trace-1" } : undefined,
    links: extraPayload ? { dashboard: "/console" } : undefined,
    secret: extraPayload ? "top-secret" : undefined,
  };
}

function createUnresolvedFeedEventsApp(): Hono {
  const xtrmDb = new Database(":memory:");
  xtrmDb.exec(`
    CREATE TABLE specialist_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter({ jobsByBead: () => [], inFlightJobs: () => [], recentJobs: () => [], chainById: () => [] }, xtrmDb, { listRepos: () => [{ repoSlug: "repo-a", repoPath: join(dir, "repo-a"), dbPath: join(dir, "repo-a.db"), mtimeMs: 0 }], getEpoch: () => 0 }));
  return app;
}

function resolvedJob(): SpecialistJob {
  return {
    repoSlug: "repo-a",
    jobId: "job-1",
    beadId: "bead-1",
    chainId: null,
    epicId: null,
    chainKind: "executor",
    status: "done",
    updatedAt: "2026-01-01T00:00:00.000Z",
    specialist: "executor",
    lastOutput: null,
    turns: null,
    tools: null,
    model: null,
  };
}

function eventPayload(extraPayload = false): Record<string, unknown> {
  return extraPayload ? { schema_version: 1, event_family: "chain", event_name: "participant_joined", resource: { participant_kind: "agent", participant_role: "executor", secret: "hide" }, correlation: { job_id: "job-1", body: "nope", path: "/tmp/secret" }, redaction: { status: "redacted" }, secret: "top-secret" } : { schema_version: 1, event_family: "chain", event_name: "participant_joined", resource: { participant_kind: "agent", participant_role: "executor" }, correlation: { job_id: "job-1" }, redaction: { status: "redacted" } };
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
        specialist TEXT,
        last_output TEXT
      );
      CREATE TABLE specialist_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        seq INTEGER,
        specialist TEXT,
        bead_id TEXT,
        t INTEGER,
        type TEXT,
        event_json TEXT
      );
      CREATE TABLE specialist_job_metrics (
        job_id TEXT PRIMARY KEY,
        total_turns INTEGER,
        total_tools INTEGER,
        model TEXT
      );
    `);
    const insert = db.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    let counter = 0;
    for (const row of rows) { counter += 1; insert.run(`job-${counter}`, row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs, "explorer"); }
  }
  return db;
}
