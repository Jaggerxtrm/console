import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createXtrmDatabase } from "../../src/state/database.ts";
import { GithubPoller, aggregateReviewState } from "../../src/github/poller.ts";
import { getPr, getPrs, upsertPr, type GithubPr } from "../../src/github/store.ts";

// XTRM-1110: the /pulls list carries no diff stats, comment count, reviews or checks; the poller
// enriches a bounded set of PRs so the console list rows carry real values.

const REPO = "owner/repo-a";
const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

const listRow = (number: number, over: Partial<GithubPr> = {}): GithubPr => ({
  repo: REPO, number, title: `PR ${number}`, body: null, state: "open", author: "alice", url: null,
  additions: null, deletions: null, changed_files: null, comment_count: null as unknown as number, label_names: null,
  created_at: recent, updated_at: recent, merged_at: null, closed_at: null, ...over,
});

type Routes = Record<string, { status?: number; body: unknown }>;
function mockGithub(routes: Routes) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    // Exact path match (query string ignored): a prefix match would let /pulls/1 answer /pulls/101.
    const bare = path.split("?")[0];
    const hit = Object.entries(routes).find(([route]) => bare === route);
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  });
  return calls;
}

const prRoutes = (number: number, sha: string): Routes => ({
  [`/repos/${REPO}/pulls/${number}/reviews`]: { body: [
    { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
    { user: { login: "bob" }, state: "APPROVED" },
    { user: { login: "carol" }, state: "COMMENTED" },
  ] },
  [`/repos/${REPO}/pulls/${number}`]: { body: { additions: 120, deletions: 7, changed_files: 4, comments: 3, head: { sha } } },
  [`/repos/${REPO}/commits/${sha}/check-runs`]: { body: { check_runs: [
    { name: "ci", status: "completed", conclusion: "success", html_url: null },
    { name: "e2e", status: "in_progress", conclusion: null, html_url: null },
  ] } },
  [`/repos/${REPO}/commits/${sha}/status`]: { body: { statuses: [] } },
});

describe("aggregateReviewState", () => {
  it("takes each reviewer's latest decision; a change request beats an approval", () => {
    expect(aggregateReviewState([])).toBe("none");
    expect(aggregateReviewState([{ user: { login: "a" }, state: "COMMENTED" }])).toBe("commented");
    expect(aggregateReviewState([{ user: { login: "a" }, state: "APPROVED" }])).toBe("approved");
    expect(aggregateReviewState([
      { user: { login: "a" }, state: "APPROVED" },
      { user: { login: "b" }, state: "CHANGES_REQUESTED" },
    ])).toBe("changes_requested");
    // A later approval by the same reviewer clears that reviewer's change request.
    expect(aggregateReviewState([
      { user: { login: "a" }, state: "CHANGES_REQUESTED" },
      { user: { login: "a" }, state: "APPROVED" },
    ])).toBe("approved");
  });
});

describe("PR enrichment (XTRM-1110)", () => {
  let db: ReturnType<typeof createXtrmDatabase>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pr-enrichment-test-"));
    // The production store initializer (apps/console server index.ts), not the standalone github schema.
    db = createXtrmDatabase(join(tmpDir, "state.db"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fills diff, comments, review and check state on the list row", async () => {
    upsertPr(db, listRow(7));
    mockGithub(prRoutes(7, "abc"));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    expect(await poller.enrichPullRequests(REPO)).toBe(1);
    const [row] = getPrs(db, { repo: REPO });
    expect(row).toMatchObject({ additions: 120, deletions: 7, changed_files: 4, comment_count: 3, review_state: "approved", review_count: 3, check_state: "pending", enriched_updated_at: recent });
  });

  it("does not enrich again until the PR changes, and a list pass keeps the enrichment", async () => {
    upsertPr(db, listRow(7));
    const calls = mockGithub(prRoutes(7, "abc"));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    await poller.enrichPullRequests(REPO);
    const before = calls.length;
    expect(await poller.enrichPullRequests(REPO)).toBe(0);
    expect(calls.length).toBe(before);

    // The next /pulls list pass re-upserts the row with null stats: the enrichment survives.
    upsertPr(db, listRow(7));
    expect(getPr(db, REPO, 7)).toMatchObject({ additions: 120, comment_count: 3, review_state: "approved", check_state: "pending" });

    // A newer updated_at makes it due again.
    const later = new Date().toISOString();
    upsertPr(db, listRow(7, { updated_at: later }));
    expect(await poller.enrichPullRequests(REPO)).toBe(1);
    expect(getPr(db, REPO, 7)!.enriched_updated_at).toBe(later);
  });

  it("enriches open PRs and recent closed ones, skips old closed ones, and respects the per-repo cap", async () => {
    upsertPr(db, listRow(1));
    upsertPr(db, listRow(2, { state: "merged" }));
    upsertPr(db, listRow(3, { state: "closed", created_at: old, updated_at: old }));
    upsertPr(db, listRow(4));
    mockGithub({ ...prRoutes(1, "s1"), ...prRoutes(2, "s2"), ...prRoutes(4, "s4") });
    const capped = new GithubPoller(db, "t", { intervalMs: 300_000, prEnrichPerRepo: 2 });
    expect(await capped.enrichPullRequests(REPO)).toBe(2);
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    expect(await poller.enrichPullRequests(REPO)).toBe(1);
    expect(getPr(db, REPO, 3)!.enriched_updated_at).toBeNull();
  });

  it("stops when the rate limit pauses the poller and leaves the rest for the next cycle", async () => {
    upsertPr(db, listRow(1));
    upsertPr(db, listRow(2));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600), "x-ratelimit-limit": "5000" } }));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    expect(await poller.enrichPullRequests(REPO)).toBe(0);
    expect(getPrs(db, { repo: REPO }).every((p) => p.enriched_updated_at === null)).toBe(true);
  });

  it("keeps stored values and leaves the PR due when a sub-read fails", async () => {
    upsertPr(db, listRow(7));
    mockGithub(prRoutes(7, "abc"));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    await poller.enrichPullRequests(REPO);
    vi.restoreAllMocks();
    const later = new Date().toISOString();
    upsertPr(db, listRow(7, { updated_at: later }));
    mockGithub({
      [`/repos/${REPO}/pulls/7/reviews`]: { status: 500, body: {} },
      [`/repos/${REPO}/pulls/7`]: { body: { additions: 121, deletions: 7, changed_files: 4, comments: 3, head: { sha: "abc" } } },
      [`/repos/${REPO}/commits/abc/check-runs`]: { status: 502, body: {} },
      [`/repos/${REPO}/commits/abc/status`]: { body: { statuses: [] } },
    });
    expect(await poller.enrichPullRequests(REPO)).toBe(0);
    const row = getPr(db, REPO, 7)!;
    // The fresh diff is stored; the unread review and check state keep their values.
    expect(row).toMatchObject({ additions: 121, review_state: "approved", check_state: "pending" });
    // Not settled at the new updated_at, so the next cycle tries again.
    expect(row.enriched_updated_at).not.toBe(later);
  });

  it("stops offering a PR a slot after three failed attempts at the same revision", async () => {
    upsertPr(db, listRow(9));
    const calls = mockGithub({ [`/repos/${REPO}/pulls/9`]: { status: 500, body: {} } });
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    for (let i = 0; i < 3; i++) await poller.enrichPullRequests(REPO);
    const after = calls.length;
    await poller.enrichPullRequests(REPO);
    expect(calls.length).toBe(after);
  });

  it("does not charge a rate-limit pause as a PR failure", async () => {
    upsertPr(db, listRow(7));
    const lowQuota = { "x-ratelimit-remaining": "10", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1) };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ additions: 1, deletions: 1, changed_files: 1, comments: 0, head: { sha: "abc" } }), { status: 200, headers: lowQuota }));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    for (let i = 0; i < 3; i++) {
      await poller.enrichPullRequests(REPO);
      (poller as unknown as { pausedUntil: number }).pausedUntil = 0;
    }
    vi.restoreAllMocks();
    mockGithub(prRoutes(7, "abc"));
    expect(await poller.enrichPullRequests(REPO)).toBe(1);
  });

  it("does not let exhausted PRs fill the window and starve healthy ones", async () => {
    const routes: Routes = {};
    for (let n = 1; n <= 4; n++) {
      upsertPr(db, listRow(n, { updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
      Object.assign(routes, prRoutes(n, `s${n}`));
    }
    for (let n = 101; n <= 124; n++) {
      upsertPr(db, listRow(n));
      routes[`/repos/${REPO}/pulls/${n}`] = { status: 500, body: {} };
    }
    mockGithub(routes);
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    let settled = 0;
    for (let cycle = 0; cycle < 12; cycle++) settled += await poller.enrichPullRequests(REPO);
    expect(settled).toBe(4);
    for (let n = 1; n <= 4; n++) expect(getPr(db, REPO, n)!.enriched_updated_at).not.toBeNull();
  });

  it("reads a failed legacy commit status as failure, not success", async () => {
    upsertPr(db, listRow(7));
    mockGithub({
      ...prRoutes(7, "abc"),
      [`/repos/${REPO}/commits/abc/check-runs`]: { body: { check_runs: [] } },
      [`/repos/${REPO}/commits/abc/status`]: { body: { statuses: [{ context: "ci/legacy", state: "FAILURE", target_url: null }] } },
    });
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    await poller.enrichPullRequests(REPO);
    expect(getPr(db, REPO, 7)!.check_state).toBe("failure");
  });

  it("does not settle a PR when the rate limit pauses the poller after its detail read", async () => {
    upsertPr(db, listRow(7));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ additions: 1, deletions: 1, changed_files: 1, comments: 0, head: { sha: "abc" } }), {
          status: 200,
          headers: { "x-ratelimit-remaining": "10", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
        });
      }
      return new Response("[]", { status: 200 });
    });
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    expect(await poller.enrichPullRequests(REPO)).toBe(0);
    expect(getPr(db, REPO, 7)!.enriched_updated_at).toBeNull();
  });
});

describe("production store migration (XTRM-1110)", () => {
  it("adds the enrichment columns to an existing github_prs table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-enrichment-migrate-"));
    const path = join(dir, "state.db");
    // A store created before this change: github_prs without the four columns.
    const before = createXtrmDatabase(path);
    for (const column of ["review_state", "review_count", "check_state", "enriched_updated_at"]) {
      before.exec(`ALTER TABLE github_prs DROP COLUMN ${column}`);
    }
    before.close();
    const db = createXtrmDatabase(path);
    const columns = (db.query("PRAGMA table_info(github_prs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["review_state", "review_count", "check_state", "enriched_updated_at"]));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});
