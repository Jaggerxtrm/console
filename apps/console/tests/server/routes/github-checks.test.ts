import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "../../../src/server/routes/github.ts";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { clearPrChecksCache, createGithubAuthService, upsertPr, upsertRepo, type StoredUserToken, type TokenStore } from "../../../../../packages/core/src/github/index.ts";

/** Fake GitHub REST server for the checks/mergeability passthrough. */

let dir: string;
let db: Database;
let fetchLog: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtrm404-checks-"));
  db = createDatabase(join(dir, "state.db"));
  process.env.GITHUB_TOKEN = "test-token";
  process.env.XTRM_GITHUB_API_BASE_URL = "https://api.fake";
  fetchLog = [];
  clearPrChecksCache();
  upsertRepo(db, { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null });
  upsertPr(db, {
    repo: "owner/repo", number: 1, title: "PR", body: null, state: "open", author: "alice", url: null,
    additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null,
    created_at: "2026-09-16T10:00:00Z", updated_at: "2026-09-16T11:00:00Z", merged_at: null, closed_at: null,
  });
  upsertPr(db, {
    repo: "owner/repo", number: 9, title: "Remote-only PR", body: null, state: "open", author: "bob", url: null,
    additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null,
    created_at: "2026-09-16T10:00:00Z", updated_at: "2026-09-16T11:00:00Z", merged_at: null, closed_at: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.GITHUB_TOKEN;
  delete process.env.XTRM_GITHUB_API_BASE_URL;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** Router with an isolated no-I/O auth service (no global token provider). */
function makeRouter(): ReturnType<typeof createGithubRouter> {
  let record: StoredUserToken | null = null;
  const store: TokenStore = {
    kind: "file",
    async get() { return record; },
    async set(next) { record = next; },
    async delete() { record = null; },
  };
  return createGithubRouter(db, undefined, undefined, {
    auth: createGithubAuthService({ env: {}, store, registerTokenProvider: false }),
  });
}

function mockGithub(pr: Record<string, unknown> | { status: number }, checkRuns: unknown = null, statuses: unknown = null): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = String(input);
    fetchLog.push(url);
    if (url.endsWith("/repos/owner/repo/pulls/1") || url.endsWith("/repos/owner/repo/pulls/9")) return "status" in (pr as { status: number }) ? jsonResponse({}, (pr as { status: number }).status) : jsonResponse(pr);
    if (url.endsWith("/commits/abc123/check-runs")) return checkRuns ? jsonResponse(checkRuns) : jsonResponse({ total_count: 0, check_runs: [] });
    if (url.endsWith("/commits/abc123/status")) return statuses ? jsonResponse(statuses) : jsonResponse({ state: "", statuses: [] });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const livePr = (overrides: Record<string, unknown> = {}) => ({
  head: { sha: "abc123" }, mergeable: true, mergeable_state: "clean", state: "open", ...overrides,
});

const checkRun = (name: string, status: string, conclusion: string | null) => ({
  name, status, conclusion, html_url: `https://github.com/owner/repo/runs/${name}`,
});

const commitStatus = (context: string, state: string) => ({
  context, state, target_url: `https://ci.example.com/${context}`,
});

describe("GET /api/github/prs/:owner/:repo/:number/checks", () => {
  it("aggregates check runs and commit statuses into a pending state with mergeability", async () => {
    mockGithub(livePr(), {
      total_count: 2,
      check_runs: [checkRun("build", "completed", "success"), checkRun("lint", "in_progress", null)],
    }, { state: "pending", statuses: [commitStatus("ci/legacy", "pending")] });

    const app = makeRouter();
    const response = await app.request("http://localhost/prs/owner/repo/1/checks");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      state: "pending",
      checks: [
        { name: "build", status: "completed", conclusion: "success", url: "https://github.com/owner/repo/runs/build", source: "check_run" },
        { name: "lint", status: "in_progress", conclusion: null, url: "https://github.com/owner/repo/runs/lint", source: "check_run" },
        { name: "ci/legacy", status: "completed", conclusion: "pending", url: "https://ci.example.com/ci/legacy", source: "status" },
      ],
      head_sha: "abc123",
      mergeable: true,
      mergeable_state: "clean",
    });
  });

  it("reports failure when any check or status failed", async () => {
    mockGithub(livePr(), {
      total_count: 2,
      check_runs: [checkRun("build", "completed", "success"), checkRun("e2e", "completed", "timed_out")],
    }, { state: "failure", statuses: [commitStatus("ci/legacy", "error")] });

    const app = makeRouter();
    const body = await (await app.request("http://localhost/prs/owner/repo/1/checks")).json();
    expect(body.state).toBe("failure");
    expect(body.checks).toHaveLength(3);
  });

  it("reports success and none states", async () => {
    mockGithub(livePr(), { total_count: 1, check_runs: [checkRun("build", "completed", "success")] }, { state: "success", statuses: [commitStatus("ci/legacy", "success")] });
    const app = makeRouter();
    expect((await (await app.request("http://localhost/prs/owner/repo/1/checks")).json()).state).toBe("success");

    mockGithub(livePr());
    clearPrChecksCache();
    const app2 = makeRouter();
    expect((await (await app2.request("http://localhost/prs/owner/repo/1/checks")).json()).state).toBe("none");
  });

  it("returns 404 when the PR is unknown locally or remotely", async () => {
    mockGithub(livePr());
    const app = makeRouter();
    // Unknown to the local store: no GitHub fetch at all.
    fetchLog = [];
    expect((await app.request("http://localhost/prs/owner/repo/999/checks")).status).toBe(404);
    expect(fetchLog).toHaveLength(0);
    // Known locally but deleted remotely.
    mockGithub({ status: 404 });
    const app2 = makeRouter();
    expect((await app2.request("http://localhost/prs/owner/repo/9/checks")).status).toBe(404);
  });

  it("retries once for lazily computed mergeability and keeps null when unknown", async () => {
    vi.useFakeTimers();
    let pullsCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      fetchLog.push(url);
      if (url.endsWith("/repos/owner/repo/pulls/1")) {
        pullsCalls += 1;
        // First response null (GitHub computing), second still null.
        return jsonResponse(livePr({ mergeable: null, mergeable_state: "unknown" }));
      }
      if (url.endsWith("/commits/abc123/check-runs")) return jsonResponse({ total_count: 0, check_runs: [] });
      if (url.endsWith("/commits/abc123/status")) return jsonResponse({ state: "", statuses: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const app = makeRouter();
    const pending = app.request("http://localhost/prs/owner/repo/1/checks");
    await vi.advanceTimersByTimeAsync(5000); // crosses the 1.5 s mergeability retry wherever it lands
    const body = await (await pending).json();
    expect(pullsCalls).toBe(2);
    expect(body.mergeable).toBeNull();
    expect(body.mergeable_state).toBe("unknown");
    expect(body.state).toBe("none");
  });

  it("serves the second view from the TTL cache", async () => {
    mockGithub(livePr(), { total_count: 1, check_runs: [checkRun("build", "completed", "success")] }, { state: "success", statuses: [] });
    const app = makeRouter();
    const first = await (await app.request("http://localhost/prs/owner/repo/1/checks")).json();
    const pullsFetches = fetchLog.filter((url) => url.endsWith("/pulls/1")).length;
    expect(pullsFetches).toBe(1);

    const second = await (await app.request("http://localhost/prs/owner/repo/1/checks")).json();
    expect(second.state).toBe("success");
    expect(second.cached_at).toBeTruthy();
    expect(fetchLog.filter((url) => url.endsWith("/pulls/1")).length).toBe(pullsFetches);
    expect(first.cached_at).toBeUndefined();
  });
});
