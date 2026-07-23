import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import {
  insertCommit,
  insertEvent,
  upsertIssue,
  upsertPr,
  upsertRelease,
  upsertRepo,
} from "../../../../packages/core/src/github/index.ts";
import type { SpecialistJob } from "../../src/types/specialists.ts";
import { createGithubRouter as createConsoleGithubRouter } from "../../src/server/routes/github.ts";
import { createExploreAgentopsRouter as createConsoleExploreAgentopsRouter } from "../../src/server/routes/explore-agentops.ts";
import { createInternalParityRouter as createConsoleInternalParityRouter } from "../../src/server/routes/internal-parity.ts";
import { createInternalVerifyRouter as createConsoleInternalVerifyRouter } from "../../src/server/routes/internal-verify.ts";
import { createObservabilityRouter as createConsoleObservabilityRouter } from "../../src/server/routes/observability.ts";
import { createSpecialistsRouter as createConsoleSpecialistsRouter, type SpecialistsDao } from "../../src/server/routes/specialists.ts";
import { createGithubRouter as createGitboardGithubRouter } from "../../../gitboard/src/api/routes/github.ts";
import { createExploreAgentopsRouter as createGitboardExploreAgentopsRouter } from "../../../gitboard/src/api/routes/explore-agentops.ts";
import { createInternalParityRouter as createGitboardInternalParityRouter } from "../../../gitboard/src/api/routes/internal-parity.ts";
import { createInternalVerifyRouter as createGitboardInternalVerifyRouter } from "../../../gitboard/src/api/routes/internal-verify.ts";
import { createObservabilityRouter as createGitboardObservabilityRouter } from "../../../gitboard/src/api/routes/observability.ts";
import { createSpecialistsRouter as createGitboardSpecialistsRouter } from "../../../gitboard/src/api/routes/specialists.ts";

type XtrmDatabase = ReturnType<typeof createXtrmDatabase>;

const roots: string[] = [];
const originalAdminToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  process.env.CONSOLE_WRITE_ADMIN_TOKEN = "parity-secret";
  delete process.env.GITHUB_TOKEN;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalAdminToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalAdminToken;
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 3 old/new host API parity", () => {
  it("keeps GitHub reads, pagination, 404s, writes, and persisted state identical", async () => {
    const oldFixture = await createFixture("github-old");
    const newFixture = await createFixture("github-new");
    const oldApp = githubApp(createGitboardGithubRouter(oldFixture.db, {} as never));
    const newApp = githubApp(createConsoleGithubRouter(newFixture.db, undefined, { emit: () => {} }));

    for (const path of [
      "/api/github/events?limit=1&offset=0",
      "/api/github/events/event-1",
      "/api/github/events/missing",
      "/api/github/commits/sha-1",
      "/api/github/repos",
      "/api/github/repos/stats",
      "/api/github/prs?limit=1&offset=0",
      "/api/github/prs/owner/repo/1",
      "/api/github/issues?limit=1&offset=0",
      "/api/github/issues/owner/repo/2",
      "/api/github/releases?repo=owner/repo&limit=1&offset=0",
    ]) await expectSameResponse(oldApp, newApp, path);

    const createRequest = () => new Request("http://localhost/api/github/repos", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json", "x-console-write-token": "parity-secret" },
      body: JSON.stringify({ full_name: "owner/new-repo", display_name: "New repo", group_name: "console" }),
    });
    const [oldCreate, newCreate] = await Promise.all([oldApp.fetch(createRequest()), newApp.fetch(createRequest())]);
    expect(newCreate.status).toBe(oldCreate.status);
    expect(await newCreate.json()).toEqual(await oldCreate.json());

    const updateRequest = () => new Request("http://localhost/api/github/repos/owner%2Fnew-repo", {
      method: "PUT",
      headers: { host: "localhost", "content-type": "application/json", "x-console-write-token": "parity-secret" },
      body: JSON.stringify({ display_name: "Renamed", color: "#123456" }),
    });
    const [oldUpdate, newUpdate] = await Promise.all([oldApp.fetch(updateRequest()), newApp.fetch(updateRequest())]);
    expect(newUpdate.status).toBe(oldUpdate.status);
    expect(await newUpdate.json()).toEqual(await oldUpdate.json());

    const persisted = (db: XtrmDatabase) => db.query(
      "SELECT full_name, display_name, tracked, group_name, color FROM github_repos WHERE full_name = 'owner/new-repo'",
    ).get();
    expect(persisted(newFixture.db)).toEqual(persisted(oldFixture.db));
    expect(persisted(newFixture.db)).toEqual({
      full_name: "owner/new-repo", display_name: "Renamed", tracked: 1, group_name: "console", color: "#123456",
    });

    const denied = await newApp.request("http://localhost/api/github/repos", {
      method: "POST",
      headers: { host: "localhost", origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ full_name: "owner/denied" }),
    });
    expect(denied.status).toBe(403);

    oldFixture.db.close();
    newFixture.db.close();
  });

  it("keeps specialists read envelopes, filtering, freshness, and 404s identical", async () => {
    const oldApp = specialistsApp(createGitboardSpecialistsRouter(specialistsDao(), specialistOptions()));
    const newApp = specialistsApp(createConsoleSpecialistsRouter(specialistsDao(), specialistOptions()));

    for (const path of [
      "/api/specialists/jobs?bead_id=bead-1",
      "/api/specialists/jobs",
      "/api/specialists/jobs/in-flight?repo_slug=repo-a&limit=5",
      "/api/specialists/chains/chain-1",
      "/api/specialists/chains/missing",
    ]) await expectSameResponse(oldApp, newApp, path);

    const [oldProtected, newProtected] = await Promise.all([
      oldApp.request("http://localhost/api/specialists/jobs/job-1/result"),
      newApp.request("http://localhost/api/specialists/jobs/job-1/result"),
    ]);
    expect(newProtected.status).toBe(oldProtected.status);
    expect(newProtected.status).toBe(403);
    expect(await newProtected.json()).toEqual(await oldProtected.json());
  });

  it("keeps observability and Explore read models identical on isolated durable state", async () => {
    const oldFixture = await createFixture("read-model-old");
    const newFixture = await createFixture("read-model-new");
    seedSpecialistJob(oldFixture.db);
    seedSpecialistJob(newFixture.db);
    const metricsDao = {
      summary: () => ({
        totalJobs: 1, completedJobs: 1, failedJobs: 0, activeJobs: 0,
        reviewerOutcomes: { pass: 1, fail: 0, needsWork: 0 },
        roleStats: [], modelStats: [], slowestJobs: [], highTurnJobs: [], failureTaxonomy: [],
        staleWarnings: 0, waitingJobs: 0,
      }),
      coverage: () => ({ attached: ["repo-a"], skipped: [], totalDiscovered: 1 }),
    } as never;
    const oldApp = new Hono()
      .route("/api/console/observability", createGitboardObservabilityRouter(metricsDao))
      .route("/api/console/explore", createGitboardExploreAgentopsRouter(oldFixture.db, { now: Date.parse("2026-07-23T12:00:00.000Z"), emit: () => {} }));
    const newApp = new Hono()
      .route("/api/console/observability", createConsoleObservabilityRouter(metricsDao))
      .route("/api/console/explore", createConsoleExploreAgentopsRouter(newFixture.db, { now: Date.parse("2026-07-23T12:00:00.000Z"), emit: () => {} }));

    for (const path of [
      "/api/console/observability/summary?range=30d",
      "/api/console/explore/agentops?range=30d&repo_slug=repo-a&status=error",
      "/api/console/explore/agentops?range=7d&repo_slug=missing",
    ]) await expectSameResponse(oldApp, newApp, path);

    oldFixture.db.close();
    newFixture.db.close();
  });

  it("keeps bounded internal verification and redacted parity responses identical", async () => {
    const verification = { by_component: {}, by_event: {}, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3, breaches: [] };
    const harness = {
      getParityOkCount: () => 4,
      getLatestSummary: () => ({
        started_at: "2026-07-23T11:00:00.000Z", finished_at: "2026-07-23T11:00:01.000Z",
        parity_ok_count: 4, diff_count: 0,
        checks: { inFlightJobs: { live: 1, shadow: 1, diffs: 0 } }, diffs: [],
      }),
    };
    const oldApp = new Hono()
      .route("/api/internal", createGitboardInternalVerifyRouter({ verify: async () => verification, emit: () => {} }))
      .route("/api/internal", createGitboardInternalParityRouter(() => harness));
    const newApp = new Hono()
      .route("/api/internal", createConsoleInternalVerifyRouter({ verify: async () => verification, emit: () => {} }))
      .route("/api/internal", createConsoleInternalParityRouter(() => harness));

    for (const path of [
      "/api/internal/verify-runtime?since=2026-07-23T11:00:00.000Z&until=2026-07-23T12:00:00.000Z",
      "/api/internal/verify-runtime?since=invalid&until=2026-07-23T12:00:00.000Z",
      "/api/internal/parity/observability",
    ]) await expectSameResponse(oldApp, newApp, path, { host: "localhost", "x-xtrm-peer-address": "127.0.0.1" });

    const hostile = await newApp.request("http://localhost/api/internal/parity/observability", {
      headers: { host: "localhost", "x-xtrm-peer-address": "10.0.0.9" },
    });
    expect(hostile.status).toBe(403);
  });
});

async function expectSameResponse(
  oldApp: Hono,
  newApp: Hono,
  path: string,
  headers: Record<string, string> = { host: "localhost" },
): Promise<void> {
  const [oldResponse, newResponse] = await Promise.all([
    oldApp.request(`http://localhost${path}`, { headers }),
    newApp.request(`http://localhost${path}`, { headers }),
  ]);
  expect(newResponse.status, path).toBe(oldResponse.status);
  expect(await newResponse.json(), path).toEqual(await oldResponse.json());
}

async function createFixture(name: string): Promise<{ root: string; db: XtrmDatabase }> {
  const root = await mkdtemp(join(tmpdir(), `console-phase3-parity-${name}-`));
  roots.push(root);
  const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
  upsertRepo(db, { full_name: "owner/repo", display_name: "Repo", tracked: true, group_name: null, last_polled_at: null, color: null });
  insertEvent(db, {
    id: "event-1", type: "PushEvent", repo: "owner/repo", branch: "main", actor: "alice", action: null,
    title: "commit", body: null, url: "https://github.com/owner/repo", additions: 1, deletions: 0,
    changed_files: 1, commit_count: 1, created_at: "2026-07-22T10:00:00Z",
  });
  insertCommit(db, {
    sha: "sha-1", repo: "owner/repo", branch: "main", author: "alice", message: "commit",
    url: "https://github.com/owner/repo/commit/sha-1", additions: null, deletions: null,
    changed_files: null, event_id: "event-1", committed_at: "2026-07-22T10:00:00Z",
  });
  upsertPr(db, {
    repo: "owner/repo", number: 1, title: "PR", body: "body", state: "open", author: "alice",
    url: "https://github.com/owner/repo/pull/1", additions: 1, deletions: 2, changed_files: 3,
    comment_count: 0, label_names: null, created_at: "2026-07-22T10:00:00Z",
    updated_at: "2026-07-22T11:00:00Z", merged_at: null, closed_at: null,
  });
  upsertIssue(db, {
    repo: "owner/repo", number: 2, title: "Issue", body: "body", state: "open", author: "alice",
    url: "https://github.com/owner/repo/issues/2", comment_count: 0, label_names: null,
    created_at: "2026-07-22T10:00:00Z", updated_at: "2026-07-22T11:00:00Z", closed_at: null,
  });
  upsertRelease(db, {
    id: "release-1", tag_name: "v1", name: "v1", body: "notes",
    html_url: "https://github.com/owner/repo/releases/v1", author_login: "alice",
    published_at: "2026-07-22T12:00:00Z", repo_full_name: "owner/repo",
  });
  return { root, db };
}

function githubApp(router: Hono): Hono {
  return new Hono().route("/api/github", router);
}

function specialistsApp(router: Hono): Hono {
  return new Hono().route("/api/specialists", router);
}

function specialistOptions() {
  return {
    listRepos: () => [{ repoSlug: "repo-a", repoPath: "/tmp/repo-a", dbPath: "/tmp/repo-a/observability.sqlite", mtimeMs: 0 }],
    getEpoch: () => 7,
    emit: () => {},
  };
}

function specialistsDao(): SpecialistsDao {
  const running = specialistJob("job-1", "running");
  const done = specialistJob("job-2", "done");
  return {
    jobsByBead: (beadId) => beadId === "bead-1" ? [running, done] : [],
    inFlightJobs: (filter) => !filter?.repoSlugs?.length || filter.repoSlugs.includes("repo-a") ? [running] : [],
    recentJobs: () => [done],
    chainById: (chainId) => chainId === "chain-1" ? [running, done] as never : [],
    coverage: () => ({ attached: ["repo-a"], skipped: [], totalDiscovered: 1 }),
  };
}

function specialistJob(jobId: string, status: string): SpecialistJob {
  return {
    jobId, repoSlug: "repo-a", beadId: "bead-1", chainId: "chain-1", epicId: null,
    chainKind: jobId === "job-1" ? "executor" : "reviewer", status,
    updatedAt: jobId === "job-1" ? "2026-07-23T11:00:00.000Z" : "2026-07-23T10:00:00.000Z",
    specialist: jobId === "job-1" ? "executor" : "reviewer", lastOutput: null,
    turns: 1, tools: 2, model: "test-model",
  };
}

function seedSpecialistJob(db: XtrmDatabase): void {
  db.query(`
    INSERT INTO specialist_jobs (
      repo_slug, job_id, bead_id, specialist, status, model, turns, tools,
      token_input, token_output, token_cache_read, token_cache_creation,
      token_reasoning, token_tool, created_at, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "repo-a", "job-error", "bead-1", "executor", "error", "test-model", 2, 3,
    4, 5, 0, 0, 0, 0, "2026-07-23T11:00:00.000Z", Date.parse("2026-07-23T11:30:00.000Z"),
  );
}
