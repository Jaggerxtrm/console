import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "../../../src/server/routes/github.ts";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { upsertPr, upsertRepo } from "../../../../../packages/core/src/github/index.ts";

/**
 * Recorded GitHub fixtures for the enriched PR detail payload (XTRM-422).
 * Each test uses a distinct PR updated_at so the module TTL cache stays hermetic.
 */

let dir: string;
let db: Database;
let seq = 0;

const AVATAR = "https://avatars.githubusercontent.com/u/130971651?v=4";

function seedPr(updatedAt: string) {
  upsertPr(db, {
    repo: "owner/repo", number: 1, title: "PR", body: "row body", state: "open", author: "alice", url: null,
    additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null,
    created_at: "2026-09-16T10:00:00Z", updated_at: updatedAt, merged_at: null, closed_at: null,
  });
}

const livePr = {
  head: { ref: "feature/thing", sha: "abc123" },
  base: { ref: "main", sha: "def456" },
  draft: false,
  merged_by: null,
  user: { login: "alice", avatar_url: AVATAR },
  assignees: [{ login: "bob", avatar_url: AVATAR }],
  requested_reviewers: [{ login: "carol", avatar_url: AVATAR }],
  requested_teams: [{ slug: "reviewers", name: "Reviewers" }],
  milestone: { title: "v2", html_url: "https://github.com/owner/repo/milestone/1", due_on: "2026-10-01T00:00:00Z" },
  labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
};

const issueComments = [
  { id: 11, user: { login: "alice", avatar_url: AVATAR }, author_association: "MEMBER", body: "hello", html_url: "https://x/11", created_at: "2026-09-16T10:01:00Z", updated_at: null },
];

const reviews = [
  { id: 21, user: { login: "carol", avatar_url: AVATAR }, author_association: "MEMBER", state: "APPROVED", body: "lgtm", html_url: "https://x/21", commit_id: "abc123", submitted_at: "2026-09-16T10:02:00Z" },
];

const reviewComments = [
  {
    id: 31, user: { login: "carol", avatar_url: AVATAR }, body: "nit", path: "a.ts", line: 24, diff_hunk: "@@",
    html_url: "https://x/31", created_at: "2026-09-16T10:03:00Z", updated_at: null,
    in_reply_to_id: null, pull_request_review_id: 21, original_line: 24, start_line: null,
    original_start_line: null, side: "RIGHT", commit_id: "abc123", original_commit_id: "abc123", subject_type: "line",
  },
  {
    id: 32, user: { login: "alice", avatar_url: AVATAR }, body: "fixed", path: "a.ts", line: 24, diff_hunk: "@@",
    html_url: "https://x/32", created_at: "2026-09-16T10:04:00Z", updated_at: null,
    in_reply_to_id: 31, pull_request_review_id: 22, original_line: 24, start_line: null,
    original_start_line: null, side: "RIGHT", commit_id: "abc123", original_commit_id: "abc123", subject_type: "line",
  },
];

const commits = [
  {
    sha: "abc123", html_url: "https://x/c1",
    author: { login: "alice", avatar_url: AVATAR },
    commit: {
      message: "feat: thing\n\nlong body", author: { name: "Alice", date: "2026-09-16T10:05:00Z" },
      verification: { verified: true },
    },
  },
];

const timeline = [
  { id: 101, event: "labeled", actor: { login: "alice" }, label: { name: "bug", color: "d73a4a" }, created_at: "2026-09-16T10:06:00Z" },
  { id: 102, event: "assigned", actor: { login: "alice" }, assignee: { login: "bob", avatar_url: AVATAR }, created_at: "2026-09-16T10:07:00Z" },
  { id: 103, event: "review_requested", actor: { login: "alice" }, requested_reviewer: { login: "carol", avatar_url: AVATAR }, created_at: "2026-09-16T10:08:00Z" },
  { id: 104, event: "review_requested", actor: { login: "alice" }, requested_team: { slug: "reviewers", name: "Reviewers" }, created_at: "2026-09-16T10:09:00Z" },
  { id: 105, event: "renamed", actor: { login: "alice" }, rename: { from: "old title", to: "new title" }, created_at: "2026-09-16T10:10:00Z" },
  {
    id: 106, event: "cross-referenced", actor: { login: "bob" },
    source: { type: "issue", issue: { number: 7, title: "Other issue", html_url: "https://github.com/other/repo/issues/7", state: "open", repository_url: "https://api.github.com/repos/other/repo" } },
    created_at: "2026-09-16T10:11:00Z",
  },
  { id: 107, event: "head_ref_force_pushed", actor: { login: "alice" }, before: "000000", after: "abc123", ref: "feature/thing", created_at: "2026-09-16T10:12:00Z" },
  { id: 108, event: "merged", actor: { login: "alice" }, commit_id: "merge1", created_at: "2026-09-16T10:13:00Z" },
  { id: 109, event: "commented", actor: { login: "bob" }, body: "plain", created_at: "2026-09-16T10:14:00Z" },
];

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function mockGithub(overrides: { live?: unknown } = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/pulls/1")) return overrides.live === null
      ? new Response("{}", { status: 500 })
      : jsonResponse(overrides.live ?? livePr);
    if (url.includes("/pulls/1/reviews")) return jsonResponse(reviews);
    if (url.includes("/pulls/1/comments")) return jsonResponse(reviewComments);
    if (url.includes("/pulls/1/commits")) return jsonResponse(commits);
    if (url.includes("/pulls/1/files")) return jsonResponse([]);
    if (url.includes("/issues/1/comments")) return jsonResponse(issueComments);
    if (url.includes("/issues/1/timeline")) return jsonResponse(timeline);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xtrm422-detail-"));
  db = createDatabase(join(dir, "state.db"));
  process.env.GITHUB_TOKEN = "test-token";
  process.env.XTRM_GITHUB_API_BASE_URL = "https://api.fake";
  upsertRepo(db, { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null });
  seq += 1;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.XTRM_GITHUB_API_BASE_URL;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function detailBody(updatedAt: string) {
  seedPr(updatedAt);
  const app = createGithubRouter(db);
  const response = await app.request("http://localhost/prs/owner/repo/1/detail");
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

describe("enriched PR detail payload", () => {
  it("merges live PR fields into pr without touching row fields", async () => {
    mockGithub();
    const body = await detailBody(`2026-09-16T11:0${seq}:00Z`);
    // Row fields intact (Console v1).
    expect(body.pr).toMatchObject({ title: "PR", body: "row body", state: "open", author: "alice" });
    // Live enrichment.
    expect(body.pr).toMatchObject({
      head_ref: "feature/thing", head_sha: "abc123", base_ref: "main", base_sha: "def456",
      draft: false, merged_by: null, author_avatar_url: AVATAR,
      assignees: [{ login: "bob", avatar_url: AVATAR }],
      requested_reviewers: [{ login: "carol", avatar_url: AVATAR }],
      requested_teams: [{ slug: "reviewers", name: "Reviewers" }],
      milestone: { title: "v2", url: "https://github.com/owner/repo/milestone/1", due_on: "2026-10-01T00:00:00Z" },
      labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
    });
    expect(body.errors).toEqual({});
  });

  it("adds avatars, associations, and review commit ids", async () => {
    mockGithub();
    const body = await detailBody(`2026-09-16T12:0${seq}:00Z`);
    expect(body.comments[0]).toMatchObject({ author: "alice", author_avatar_url: AVATAR, author_association: "MEMBER", body: "hello" });
    expect(body.reviews[0]).toMatchObject({ author: "carol", author_avatar_url: AVATAR, author_association: "MEMBER", state: "APPROVED", commit_id: "abc123" });
  });

  it("preserves the review-comment reply chain and thread linkage", async () => {
    mockGithub();
    const body = await detailBody(`2026-09-16T13:0${seq}:00Z`);
    expect(body.review_comments).toHaveLength(2);
    expect(body.review_comments[1].in_reply_to_id).toBe(body.review_comments[0].id);
    expect(body.review_comments[0]).toMatchObject({
      in_reply_to_id: null, pull_request_review_id: 21, original_line: 24,
      side: "RIGHT", commit_id: "abc123", original_commit_id: "abc123", subject_type: "line",
      author_avatar_url: AVATAR,
    });
  });

  it("adds commit author identity and verification", async () => {
    mockGithub();
    const body = await detailBody(`2026-09-16T14:0${seq}:00Z`);
    expect(body.commits[0]).toMatchObject({
      sha: "abc123", message: "feat: thing", author: "Alice",
      author_login: "alice", author_avatar_url: AVATAR, verified: true,
    });
  });

  it("maps typed data for each timeline event kind", async () => {
    mockGithub();
    const body = await detailBody(`2026-09-16T15:0${seq}:00Z`);
    const byEvent = Object.fromEntries(body.timeline.map((item: any) => [`${item.event}#${item.id}`, item]));
    expect(byEvent["labeled#101"].data).toEqual({ label: { name: "bug", color: "d73a4a" } });
    expect(byEvent["assigned#102"].data).toEqual({ assignee: { login: "bob", avatar_url: AVATAR } });
    expect(byEvent["review_requested#103"].data).toEqual({
      requested_reviewer: { login: "carol", avatar_url: AVATAR }, requested_team: null,
    });
    expect(byEvent["review_requested#104"].data).toEqual({
      requested_reviewer: null, requested_team: { slug: "reviewers", name: "Reviewers" },
    });
    expect(byEvent["renamed#105"].data).toEqual({ from: "old title", to: "new title" });
    expect(byEvent["cross-referenced#106"].data).toEqual({
      source: { type: "issue", repo: "other/repo", number: 7, title: "Other issue", url: "https://github.com/other/repo/issues/7", state: "open" },
    });
    expect(byEvent["head_ref_force_pushed#107"].data).toEqual({ before: "000000", after: "abc123", ref: "feature/thing" });
    expect(byEvent["merged#108"].data).toEqual({ commit_id: "merge1" });
    expect(byEvent["commented#109"].data).toBeNull();
    // Existing timeline fields intact.
    expect(byEvent["merged#108"]).toMatchObject({ actor: "alice", commit_id: "merge1" });
  });

  it("falls back to row-only pr with errors.pr_live when the live fetch fails", async () => {
    mockGithub({ live: null });
    const body = await detailBody(`2026-09-16T16:0${seq}:00Z`);
    expect(body.errors.pr_live).toBeTruthy();
    expect(body.pr).toMatchObject({ title: "PR", author: "alice", head_ref: null, labels: [], assignees: [] });
    // Other sections still map.
    expect(body.comments).toHaveLength(1);
    expect(body.review_comments).toHaveLength(2);
  });
});
