import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createExploreAgentopsRouter } from "../../../src/api/routes/explore-agentops.ts";
import { getRing, setDiskEnabled } from "../../../src/core/logger.ts";

let db: Database;

beforeEach(() => {
  setDiskEnabled(false);
  db = new Database(":memory:", { create: true });
  db.exec(`
    CREATE TABLE specialist_jobs (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      bead_id TEXT,
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
  `);
  insertJob({ repo: "gitboard", job: "job-1", bead: "forge-a", specialist: "executor", status: "done", model: "gpt-5", turns: 4, tools: 9, tokens: 130, createdAt: "2026-06-28T10:00:00.000Z", updatedAtMs: Date.UTC(2026, 5, 28, 10, 2) });
  insertJob({ repo: "gitboard", job: "job-2", bead: "forge-b", specialist: "reviewer", status: "error", model: "gpt-5", turns: 2, tools: 3, tokens: 50, createdAt: "2026-06-28T10:00:00.000Z", updatedAtMs: Date.UTC(2026, 5, 28, 10, 8) });
  insertJob({ repo: "specialists", job: "job-3", bead: "unit-a", specialist: "executor", status: "running", model: "gpt-4", turns: 7, tools: 1, tokens: 90, createdAt: "2026-06-28T10:00:00.000Z", updatedAtMs: Date.UTC(2026, 5, 28, 10, 1) });
});

afterEach(() => db.close());

describe("GET /api/console/explore/agentops", () => {
  it("returns filtered AgentOps summary, facets, breakdowns, and job rows", async () => {
    const app = new Hono().route("/api/console/explore", createExploreAgentopsRouter(db, { now: Date.UTC(2026, 5, 29) }));

    const res = await app.request("http://localhost/api/console/explore/agentops?range=7d&repo_slug=gitboard&status=error");

    expect(res.status).toBe(200);
    const json = await res.json() as {
      filters: { repoSlug: string | null; status: string | null };
      summary: { totalJobs: number; errorJobs: number; tokenTotal: number };
      facets: { repoSlugs: Array<{ value: string; count: number }>; statuses: Array<{ value: string; count: number }> };
      statusBreakdown: Array<{ status: string; count: number }>;
      recentJobs: Array<{ jobId: string; beadId: string; specialist: string; status: string }>;
      slowestJobs: Array<{ jobId: string; elapsedMs: number }>;
      source_health: { source: string; status: string };
    };

    expect(json.filters).toMatchObject({ repoSlug: "gitboard", status: "error" });
    expect(json.summary).toMatchObject({ totalJobs: 1, errorJobs: 1, tokenTotal: 50 });
    expect(json.facets.repoSlugs).toEqual(expect.arrayContaining([{ value: "gitboard", count: 2 }]));
    expect(json.facets.statuses).toEqual(expect.arrayContaining([{ value: "error", count: 1 }]));
    expect(json.statusBreakdown).toEqual([{ status: "error", count: 1 }]);
    expect(json.recentJobs[0]).toMatchObject({ jobId: "job-2", beadId: "forge-b", specialist: "reviewer", status: "error" });
    expect(json.slowestJobs[0]).toMatchObject({ jobId: "job-2", elapsedMs: 480000 });
    expect(json.source_health).toMatchObject({ source: "explore-agentops", status: "fresh" });
  });

  it("degrades gracefully when the xtrm database is unavailable", async () => {
    const app = new Hono().route("/api/console/explore", createExploreAgentopsRouter(null));

    const res = await app.request("http://localhost/api/console/explore/agentops");

    expect(res.status).toBe(200);
    const json = await res.json() as { summary: { totalJobs: number }; source_health: { status: string; metadata: { reason: string } } };
    expect(json.summary.totalJobs).toBe(0);
    expect(json.source_health).toMatchObject({ status: "degraded", metadata: { reason: "database_unavailable" } });
  });

  it("logs bounded filter metadata without raw SQL", async () => {
    const app = new Hono().route("/api/console/explore", createExploreAgentopsRouter(db, { now: Date.UTC(2026, 5, 29) }));

    await app.request("http://localhost/api/console/explore/agentops?specialist=reviewer&model=gpt-5");

    const line = getRing().find((entry) => entry.component === "explore" && entry.event === "agentops_request");
    expect(line?.data).toMatchObject({ outcome: "ok", total_jobs: 1 });
    expect(JSON.stringify(line)).not.toContain("SELECT");
  });
});

function insertJob(input: { repo: string; job: string; bead: string; specialist: string; status: string; model: string; turns: number; tools: number; tokens: number; createdAt: string; updatedAtMs: number }) {
  db.prepare(`
    INSERT INTO specialist_jobs (
      repo_slug, job_id, bead_id, specialist, status, model, turns, tools,
      token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool,
      created_at, updated_at, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.repo,
    input.job,
    input.bead,
    input.specialist,
    input.status,
    input.model,
    input.turns,
    input.tools,
    input.tokens,
    0,
    0,
    0,
    0,
    0,
    input.createdAt,
    new Date(input.updatedAtMs).toISOString(),
    input.updatedAtMs,
  );
}
