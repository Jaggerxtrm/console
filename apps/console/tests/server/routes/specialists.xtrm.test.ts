import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../../src/server/routes/specialists.ts";
import { createAttachPool } from "../../../../../packages/core/src/observability/attach-pool.ts";
import { createObservabilityDao } from "../../../../../packages/core/src/observability/dao.ts";

let dir: string;
let xtrmDb: Database;
let liveDb: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-specialists-xtrm-"));
  xtrmDb = new Database(join(dir, "xtrm.sqlite"), { create: true });
  liveDb = new Database(join(dir, "observability.db"), { create: true });
  seedXtrm(xtrmDb);
  seedLive(liveDb);
});

afterEach(async () => {
  delete process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK;
  xtrmDb.close();
  liveDb.close();
  await rm(dir, { recursive: true, force: true });
});

describe("specialists router xtrm path", () => {
  it("matches legacy attach-pool shape for shared fields", async () => {
    const xtrmApp = appWithXtrm(xtrmDb);
    const liveApp = appWithLive(liveDb);

    const jobsRes = await xtrmApp.request("/api/specialists/jobs?bead_id=bead-1");
    const legacyJobsRes = await liveApp.request("/api/specialists/jobs?bead_id=bead-1");
    expect(jobsRes.status).toBe(200);
    expect(legacyJobsRes.status).toBe(200);
    expect(project(await jobsRes.json(), ["jobs", "freshness"]))
      .toEqual(project(await legacyJobsRes.json(), ["jobs", "freshness"]));

    const inFlightRes = await xtrmApp.request("/api/specialists/jobs/in-flight");
    const legacyInFlightRes = await liveApp.request("/api/specialists/jobs/in-flight");
    expect(inFlightRes.status).toBe(200);
    expect(legacyInFlightRes.status).toBe(200);
    expect(project(await inFlightRes.json(), ["in_flight", "recent_history", "jobs", "epoch", "freshness"]))
      .toEqual(project(await legacyInFlightRes.json(), ["in_flight", "recent_history", "jobs", "epoch", "freshness"]));

    const chainRes = await xtrmApp.request("/api/specialists/chains/chain-1");
    const legacyChainRes = await liveApp.request("/api/specialists/chains/chain-1");
    expect(chainRes.status).toBe(200);
    expect(legacyChainRes.status).toBe(200);
    expect(project(await chainRes.json(), ["chain", "freshness"]))
      .toEqual(project(await legacyChainRes.json(), ["chain", "freshness"]));
  });

  it("returns materialized specialist metrics and token split from xtrm state", async () => {
    const app = appWithXtrm(xtrmDb);
    const res = await app.request("/api/specialists/jobs/in-flight");

    expect(res.status).toBe(200);
    const json = await res.json() as { in_flight: Array<Record<string, unknown>> };
    expect(json.in_flight[0]).toMatchObject({
      jobId: "job-1",
      turns: 4,
      tools: 3,
      model: "model-x",
      tokenUsage: {
        input: 10,
        output: 12,
        cacheRead: 2,
        cacheCreation: 1,
        reasoning: 5,
        tool: 7,
        source: "specialist_job_metrics",
      },
    });
  });

  it("honors the live fallback compatibility flag", async () => {
    process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "1";
    let epoch = 0;
    const app = new Hono().route("/api/specialists", createSpecialistsRouter(undefined, xtrmDb, {
      listRepos: () => [{ repoSlug: "repo-a", repoPath: dir, dbPath: join(dir, "observability.db"), mtimeMs: 0 }],
      getEpoch: () => epoch,
    }));

    await app.request("/api/specialists/jobs/in-flight");
    await Promise.resolve();
    epoch += 1;
    const response = await app.request("/api/specialists/jobs/in-flight");
    const json = await response.json() as { jobs: Array<{ lastOutput: string | null }> };

    expect(response.status).toBe(200);
    expect(json.jobs[0]?.lastOutput).toBe("live running");
  });
});

function appWithXtrm(db: Database): Hono {
  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter(undefined, db, { listRepos: () => [], getEpoch: () => 0 }));
  return app;
}

function appWithLive(db: Database): Hono {
  const pool = createAttachPool([{ repoSlug: "repo-a", repoPath: dir, dbPath: join(dir, "observability.db"), mtimeMs: 0 }]);
  const dao = createObservabilityDao(pool);
  const app = new Hono();
  app.route("/api/specialists", createSpecialistsRouter(dao, undefined, { listRepos: () => [{ repoSlug: "repo-a", repoPath: dir, dbPath: join(dir, "observability.db"), mtimeMs: 0 }], getEpoch: () => 0 }));
  return app;
}

function seedXtrm(db: Database): void {
  db.exec(`
    CREATE TABLE substrate_job_link (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      substrate_type TEXT NOT NULL,
      substrate_id TEXT NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (repo_slug, job_id, issue_id)
    );
    CREATE TABLE specialist_jobs (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      specialist TEXT NOT NULL,
      status TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      worktree TEXT,
      last_output TEXT,
      turns INTEGER,
      tools INTEGER,
      model TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_cache_read INTEGER,
      token_cache_creation INTEGER,
      token_reasoning INTEGER,
      token_tool INTEGER,
      usage_source TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      updated_at_ms INTEGER,
      PRIMARY KEY (repo_slug, job_id)
    );
    CREATE TABLE specialist_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  db.prepare("INSERT INTO substrate_job_link (repo_slug, job_id, issue_id, substrate_type, substrate_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run("repo-a", "job-1", "bead-1", "bead", "bead-1");
  db.prepare("INSERT INTO substrate_job_link (repo_slug, job_id, issue_id, substrate_type, substrate_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run("repo-a", "job-2", "bead-2", "bead", "bead-2");
  db.prepare("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, turns, tools, model, token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool, usage_source, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "executor", "running", "chain-1", "epic-1", "executor", null, "xtrm running", 4, 3, "model-x", 10, 12, 2, 1, 5, 7, "specialist_job_metrics", "2026-01-01 00:00:00", "2026-01-01 00:00:00", 1000);
  db.prepare("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, turns, tools, model, token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool, usage_source, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-2", "reviewer", "done", "chain-1", "epic-1", "reviewer", null, "xtrm done", 2, 1, "model-y", 1, 2, 0, 0, 0, 0, "specialist_job_metrics", "2026-01-01 00:00:01", "2026-01-01 00:00:01", 2000);
  db.prepare("INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload) VALUES (?, ?, ?, ?)").run("repo-a", "job-1", "turn", "{}");
  db.prepare("INSERT INTO specialist_job_events (repo_slug, job_id, event_type, payload) VALUES (?, ?, ?, ?)").run("repo-a", "job-2", "turn", "{}");
  db.prepare("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_success_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success')").run("obs:repo-a", JSON.stringify({ updated_at_ms: 2000, event_rowid: 2 }));
}

function seedLive(db: Database): void {
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
      job_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist, last_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("job-1", "bead-1", "chain-1", "epic-1", "executor", "running", 1000, "executor", "live running");
  db.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist, last_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("job-2", "bead-2", "chain-1", "epic-1", "reviewer", "done", 2000, "reviewer", "live done");
}

function project(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, keys));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = project((value as Record<string, unknown>)[key], keys);
  return out;
}
