import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../src/github/database.ts";
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
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
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
  let db: ReturnType<typeof createDatabase>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pr-enrichment-test-"));
    db = createDatabase(join(tmpDir, "state.db"));
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

  it("keeps stored review and check state when a re-read returns nothing", async () => {
    upsertPr(db, listRow(7));
    mockGithub(prRoutes(7, "abc"));
    const poller = new GithubPoller(db, "t", { intervalMs: 300_000 });
    await poller.enrichPullRequests(REPO);
    vi.restoreAllMocks();
    // The PR changed; its sub-reads now answer 304 (unchanged).
    upsertPr(db, listRow(7, { updated_at: new Date().toISOString() }));
    mockGithub({
      [`/repos/${REPO}/pulls/7/reviews`]: { status: 304, body: null },
      [`/repos/${REPO}/pulls/7`]: { body: { additions: 121, deletions: 7, changed_files: 4, comments: 3, head: { sha: "abc" } } },
      [`/repos/${REPO}/commits/abc/check-runs`]: { status: 304, body: null },
      [`/repos/${REPO}/commits/abc/status`]: { status: 304, body: null },
    });
    await poller.enrichPullRequests(REPO);
    expect(getPr(db, REPO, 7)).toMatchObject({ additions: 121, review_state: "approved", check_state: "pending" });
  });
});
