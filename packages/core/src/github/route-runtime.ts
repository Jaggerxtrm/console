import type { Database } from "bun:sqlite";
import { fetchRepoFile, listRepoDir } from "./readme.ts";
import { githubApiBaseUrl, resolveGithubCredential } from "./token.ts";
import { getRepos, type GithubPr, type GithubRepo } from "./store.ts";

export type PrDetailPerson = { login: string; avatar_url: string | null };
export type PrDetailTeamRef = { slug: string; name: string | null };
export type PrDetailLabel = { name: string; color: string | null; description: string | null };
export type PrDetailMilestone = { title: string; url: string | null; due_on: string | null };

/** Live PR fields merged into the detail `pr` object (defaults when the live section fails). */
export type PrLiveDetails = {
  head_ref: string | null;
  head_sha: string | null;
  base_ref: string | null;
  base_sha: string | null;
  draft: boolean | null;
  merged_by: PrDetailPerson | null;
  author_avatar_url: string | null;
  assignees: PrDetailPerson[];
  requested_reviewers: PrDetailPerson[];
  requested_teams: PrDetailTeamRef[];
  milestone: PrDetailMilestone | null;
  labels: PrDetailLabel[];
};

export type PrTimelineEventData =
  | { label: { name: string; color: string | null } }
  | { assignee: PrDetailPerson }
  | { requested_reviewer: PrDetailPerson | null; requested_team: PrDetailTeamRef | null }
  | { from: string | null; to: string | null }
  | { source: { type: string | null; repo: string | null; number: number | null; title: string | null; url: string | null; state: string | null } }
  | { before: string | null; after: string | null; ref: string | null }
  | { commit_id: string | null };

export type PrDetailPayload = {
  pr: GithubPr & PrLiveDetails;
  comments: Array<{ id: number; author: string; author_avatar_url: string | null; author_association: string | null; body: string; url: string | null; created_at: string; updated_at: string | null }>;
  reviews: Array<{ id: number; author: string; author_avatar_url: string | null; author_association: string | null; state: string; body: string | null; url: string | null; commit_id: string | null; submitted_at: string | null }>;
  review_comments: Array<{ id: number; author: string; author_avatar_url: string | null; body: string; path: string | null; line: number | null; diff_hunk: string | null; url: string | null; in_reply_to_id: number | null; pull_request_review_id: number | null; original_line: number | null; start_line: number | null; original_start_line: number | null; side: string | null; commit_id: string | null; original_commit_id: string | null; subject_type: string | null; created_at: string; updated_at: string | null }>;
  commits: Array<{ sha: string; message: string; author: string; author_login: string | null; author_avatar_url: string | null; verified: boolean | null; url: string | null; committed_at: string }>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string | null }>;
  timeline: Array<{ id: string; event: string; actor: string | null; body: string | null; commit_id: string | null; state: string | null; url: string | null; data: PrTimelineEventData | null; created_at: string }>;
  errors: Record<string, string>;
  cached_at?: string;
};

export type PrDetailCacheEvent = { repo: string; number: number; hit: boolean };
export type PrDetailTimingEvent = { repo: string; number: number; totalMs: number; commentsMs: undefined | null; errors: number };

export type GithubRepoFile = Awaited<ReturnType<typeof fetchRepoFile>>;

export type GithubReportSummary = {
  name: string;
  path: string;
  sha: string;
  size: number;
  frontmatter: null;
};

const OPEN_PR_DETAIL_CACHE_TTL_MS = 60 * 1000;
const CLOSED_PR_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PR_DETAIL_CACHE_ENTRIES = 200;
const prDetailCache = new Map<string, { value: PrDetailPayload; expires: number }>();

export async function githubApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const credential = await resolveGithubCredential();
  if (!credential.token) throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
  const response = await fetch(`${githubApiBaseUrl()}${path}`, {
    signal,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge/0.1.0",
    },
  });
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: ${path}`);
  return await response.json() as T;
}

export async function githubApiPages<T>(path: string, maxPages = 3, signal?: AbortSignal): Promise<T[]> {
  const results: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`, signal);
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

export function isAllowedMarkdownPath(path: string): boolean {
  return path === "README.md" || path === "CHANGELOG.md";
}

export function isAllowedReportFilename(filename: string): boolean {
  return /^[\w.-]+\.md$/.test(filename);
}

export function isKnownGithubRepo(db: Database, owner: string, name: string): boolean {
  const fullName = `${owner}/${name}`;
  return getRepos(db).some((repo: GithubRepo) => repo.full_name === fullName);
}

export async function getMarkdownFile(owner: string, name: string, path: string): Promise<GithubRepoFile> {
  return await fetchRepoFile(owner, name, path);
}

export async function getReportFile(owner: string, name: string, filename: string): Promise<GithubRepoFile> {
  return await fetchRepoFile(owner, name, `.xtrm/reports/${filename}`);
}

export async function getReportSummaries(owner: string, name: string): Promise<GithubReportSummary[]> {
  const entries = await listRepoDir(owner, name, ".xtrm/reports");
  return entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((report) => ({ name: report.name, path: report.path, sha: report.sha, size: report.size, frontmatter: null }));
}

export async function getPrDetailPayload(
  repo: string,
  number: number,
  pr: GithubPr,
  emitCacheEvent?: (event: PrDetailCacheEvent) => void,
  emitTimingEvent?: (event: PrDetailTimingEvent) => void
): Promise<PrDetailPayload> {
  const totalStart = performance.now();
  const cacheKey = prDetailCacheKey(repo, number, pr.updated_at ?? pr.created_at);
  const cached = prDetailCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) {
    emitCacheEvent?.({ repo, number, hit: true });
    return { ...cached.value, cached_at: new Date(now).toISOString() };
  }
  emitCacheEvent?.({ repo, number, hit: false });

  const [commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult, prLiveResult] = await fetchPrDetailSections(repo, number);
  const errors = collectPrDetailErrors({ commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult, prLiveResult });
  const payload: PrDetailPayload = {
    pr: { ...pr, ...mapLivePr(prLiveResult) },
    comments: mapComments(commentsResult),
    reviews: mapReviews(reviewsResult),
    review_comments: mapReviewComments(reviewCommentsResult),
    commits: mapCommits(commitsResult, pr),
    files: mapFiles(filesResult),
    timeline: mapTimeline(timelineResult, pr),
    errors,
  };

  if (Object.keys(errors).length === 0) {
    prDetailCache.set(cacheKey, { value: payload, expires: Date.now() + prDetailCacheTtl(pr) });
    prunePrDetailCache();
  }
  emitTimingEvent?.({ repo, number, totalMs: Math.round(performance.now() - totalStart), commentsMs: commentsResult.status === "fulfilled" ? undefined : null, errors: Object.keys(errors).length });
  return payload;
}

type GithubUserRef = { login: string; avatar_url: string | null };
type CommentItem = { id: number; user: GithubUserRef | null; author_association?: string | null; body: string; html_url: string | null; created_at: string; updated_at: string | null };
type ReviewItem = { id: number; user: GithubUserRef | null; author_association?: string | null; state: string; body: string | null; html_url: string | null; commit_id?: string | null; submitted_at: string | null };
type ReviewCommentItem = {
  id: number; user: GithubUserRef | null; body: string; path: string | null; line: number | null;
  diff_hunk: string | null; html_url: string | null; created_at: string; updated_at: string | null;
  in_reply_to_id?: number | null; pull_request_review_id?: number | null; original_line?: number | null;
  start_line?: number | null; original_start_line?: number | null; side?: string | null;
  commit_id?: string | null; original_commit_id?: string | null; subject_type?: string | null;
};
type CommitItem = {
  sha: string; html_url: string | null;
  author: { login: string; avatar_url: string | null } | null;
  commit: { message: string; author: { name: string; date: string } | null; verification?: { verified: boolean | null } | null };
};
type FileItem = { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string | null };
type TimelineItem = {
  id?: number | string; event?: string; actor?: { login: string } | null; user?: { login: string } | null;
  body?: string | null; commit_id?: string | null; state?: string | null; html_url?: string | null;
  created_at?: string; submitted_at?: string;
  label?: { name: string; color?: string | null } | null;
  assignee?: { login: string; avatar_url?: string | null } | null;
  requested_reviewer?: { login: string; avatar_url?: string | null } | null;
  requested_team?: { slug?: string; name?: string | null } | null;
  rename?: { from?: string | null; to?: string | null } | null;
  source?: { type?: string | null; issue?: { number?: number | null; title?: string | null; html_url?: string | null; state?: string | null; repository_url?: string | null } | null } | null;
  before?: string | null; after?: string | null; ref?: string | null;
};
type LivePrItem = {
  head?: { ref?: string | null; sha?: string | null } | null;
  base?: { ref?: string | null; sha?: string | null } | null;
  draft?: boolean | null;
  merged_by?: { login: string; avatar_url?: string | null } | null;
  user?: { avatar_url?: string | null } | null;
  assignees?: Array<{ login: string; avatar_url?: string | null }> | null;
  requested_reviewers?: Array<{ login: string; avatar_url?: string | null }> | null;
  requested_teams?: Array<{ slug: string; name?: string | null }> | null;
  milestone?: { title: string; html_url?: string | null; due_on?: string | null } | null;
  labels?: Array<{ name: string; color?: string | null; description?: string | null }> | null;
};
type PrDetailSectionResults = readonly [
  PromiseSettledResult<CommentItem[]>,
  PromiseSettledResult<ReviewItem[]>,
  PromiseSettledResult<ReviewCommentItem[]>,
  PromiseSettledResult<CommitItem[]>,
  PromiseSettledResult<FileItem[]>,
  PromiseSettledResult<TimelineItem[]>,
  PromiseSettledResult<LivePrItem>,
];

function prDetailCacheKey(repo: string, number: number, updatedAt: string | null | undefined): string {
  return `${repo}#${number}:${updatedAt ?? "unknown"}`;
}

function prDetailCacheTtl(pr: GithubPr): number {
  return pr.state === "open" ? OPEN_PR_DETAIL_CACHE_TTL_MS : CLOSED_PR_DETAIL_CACHE_TTL_MS;
}

function prunePrDetailCache(): void {
  const now = Date.now();
  for (const [key, entry] of prDetailCache) {
    if (entry.expires <= now) prDetailCache.delete(key);
  }
  while (prDetailCache.size > MAX_PR_DETAIL_CACHE_ENTRIES) {
    const oldest = prDetailCache.keys().next().value;
    if (oldest === undefined) return;
    prDetailCache.delete(oldest);
  }
}

function prDetailSectionTimeoutMs(): number {
  const value = Number(process.env.GITBOARD_PR_DETAIL_SECTION_TIMEOUT_MS ?? 2500);
  return Number.isFinite(value) && value > 0 ? value : 2500;
}

async function withTimeout<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), prDetailSectionTimeoutMs());
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${prDetailSectionTimeoutMs()}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPrDetailSections(repo: string, number: number): Promise<PrDetailSectionResults> {
  return await Promise.allSettled([
    withTimeout("comments", (signal) => githubApiPages<CommentItem>(`/repos/${repo}/issues/${number}/comments`, 3, signal)),
    withTimeout("reviews", (signal) => githubApiPages<ReviewItem>(`/repos/${repo}/pulls/${number}/reviews`, 3, signal)),
    withTimeout("review_comments", (signal) => githubApiPages<ReviewCommentItem>(`/repos/${repo}/pulls/${number}/comments`, 3, signal)),
    withTimeout("commits", (signal) => githubApiPages<CommitItem>(`/repos/${repo}/pulls/${number}/commits`, 3, signal)),
    withTimeout("files", (signal) => githubApiPages<FileItem>(`/repos/${repo}/pulls/${number}/files`, 3, signal)),
    withTimeout("timeline", (signal) => githubApiPages<TimelineItem>(`/repos/${repo}/issues/${number}/timeline`, 3, signal)),
    withTimeout("pr_live", (signal) => githubApi<LivePrItem>(`/repos/${repo}/pulls/${number}`, signal)),
  ]) as PrDetailSectionResults;
}

function collectPrDetailErrors(results: {
  commentsResult: PromiseSettledResult<unknown>;
  reviewsResult: PromiseSettledResult<unknown>;
  reviewCommentsResult: PromiseSettledResult<unknown>;
  commitsResult: PromiseSettledResult<unknown>;
  filesResult: PromiseSettledResult<unknown>;
  timelineResult: PromiseSettledResult<unknown>;
  prLiveResult: PromiseSettledResult<unknown>;
}): Record<string, string> {
  const entries: Array<readonly [string, PromiseSettledResult<unknown>]> = [
    ["comments", results.commentsResult],
    ["reviews", results.reviewsResult],
    ["review_comments", results.reviewCommentsResult],
    ["commits", results.commitsResult],
    ["files", results.filesResult],
    ["timeline", results.timelineResult],
    ["pr_live", results.prLiveResult],
  ];

  return Object.fromEntries(entries.flatMap(([key, result]) => {
    if (result.status !== "rejected") return [];
    return [[key, result.reason instanceof Error ? result.reason.message : String(result.reason)]];
  }));
}

function mapComments(result: PromiseSettledResult<CommentItem[]>): PrDetailPayload["comments"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ id: item.id, author: item.user?.login ?? "unknown", author_avatar_url: item.user?.avatar_url ?? null, author_association: item.author_association ?? null, body: item.body, url: item.html_url, created_at: item.created_at, updated_at: item.updated_at }));
}

function mapReviews(result: PromiseSettledResult<ReviewItem[]>): PrDetailPayload["reviews"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ id: item.id, author: item.user?.login ?? "unknown", author_avatar_url: item.user?.avatar_url ?? null, author_association: item.author_association ?? null, state: item.state, body: item.body, url: item.html_url, commit_id: item.commit_id ?? null, submitted_at: item.submitted_at }));
}

function mapReviewComments(result: PromiseSettledResult<ReviewCommentItem[]>): PrDetailPayload["review_comments"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({
    id: item.id, author: item.user?.login ?? "unknown", author_avatar_url: item.user?.avatar_url ?? null,
    body: item.body, path: item.path, line: item.line, diff_hunk: item.diff_hunk, url: item.html_url,
    in_reply_to_id: item.in_reply_to_id ?? null, pull_request_review_id: item.pull_request_review_id ?? null,
    original_line: item.original_line ?? null, start_line: item.start_line ?? null,
    original_start_line: item.original_start_line ?? null, side: item.side ?? null,
    commit_id: item.commit_id ?? null, original_commit_id: item.original_commit_id ?? null,
    subject_type: item.subject_type ?? null, created_at: item.created_at, updated_at: item.updated_at,
  }));
}

function mapCommits(result: PromiseSettledResult<CommitItem[]>, pr: GithubPr): PrDetailPayload["commits"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({
    sha: item.sha, message: item.commit.message.split("\n")[0], author: item.commit.author?.name ?? "unknown",
    author_login: item.author?.login ?? null, author_avatar_url: item.author?.avatar_url ?? null,
    verified: item.commit.verification?.verified ?? null, url: item.html_url,
    committed_at: item.commit.author?.date ?? pr.updated_at ?? pr.created_at,
  }));
}

function mapFiles(result: PromiseSettledResult<FileItem[]>): PrDetailPayload["files"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ filename: item.filename, status: item.status, additions: item.additions, deletions: item.deletions, changes: item.changes, patch: item.patch ?? null }));
}

function mapTimeline(result: PromiseSettledResult<TimelineItem[]>, pr: GithubPr): PrDetailPayload["timeline"] {
  if (result.status !== "fulfilled") return [];
  return result.value
    .filter((item) => item.event || item.body || item.state)
    .map((item, index) => {
      const event = item.event ?? (item.body ? "commented" : "activity");
      return {
        id: String(item.id ?? `${item.event ?? "timeline"}-${index}`),
        event,
        actor: item.actor?.login ?? item.user?.login ?? null,
        body: item.body ?? null,
        commit_id: item.commit_id ?? null,
        state: item.state ?? null,
        url: item.html_url ?? null,
        data: mapTimelineData(item, event),
        created_at: item.created_at ?? item.submitted_at ?? pr.updated_at ?? pr.created_at,
      };
    });
}

/** Typed per-event data; unknown events keep data null (existing fields still mapped). */
function mapTimelineData(item: TimelineItem, event: string): PrTimelineEventData | null {
  switch (event) {
    case "labeled":
    case "unlabeled":
      if (!item.label) return null;
      return { label: { name: item.label.name, color: item.label.color ?? null } };
    case "assigned":
    case "unassigned":
      if (!item.assignee) return null;
      return { assignee: { login: item.assignee.login, avatar_url: item.assignee.avatar_url ?? null } };
    case "review_requested":
    case "review_request_removed":
      if (!item.requested_reviewer && !item.requested_team) return null;
      return {
        requested_reviewer: item.requested_reviewer ? { login: item.requested_reviewer.login, avatar_url: item.requested_reviewer.avatar_url ?? null } : null,
        requested_team: item.requested_team?.slug ? { slug: item.requested_team.slug, name: item.requested_team.name ?? null } : null,
      };
    case "renamed":
      if (!item.rename) return null;
      return { from: item.rename.from ?? null, to: item.rename.to ?? null };
    case "cross-referenced": {
      const source = item.source?.issue;
      if (!source) return null;
      return {
        source: {
          type: item.source?.type ?? null,
          repo: source.repository_url ? source.repository_url.replace(/^.*\/repos\//, "") : null,
          number: source.number ?? null,
          title: source.title ?? null,
          url: source.html_url ?? null,
          state: source.state ?? null,
        },
      };
    }
    case "head_ref_force_pushed":
    case "base_ref_changed":
      if (item.before == null && item.after == null && item.ref == null && item.commit_id == null) return null;
      return { before: item.before ?? item.commit_id ?? null, after: item.after ?? null, ref: item.ref ?? null };
    case "merged":
    case "closed":
    case "reopened":
    case "ready_for_review":
    case "convert_to_draft":
      if (item.commit_id == null) return null;
      return { commit_id: item.commit_id };
    default:
      return null;
  }
}

function mapPerson(user: { login: string; avatar_url?: string | null } | null | undefined): PrDetailPerson | null {
  if (!user) return null;
  return { login: user.login, avatar_url: user.avatar_url ?? null };
}

/** Live PR enrichment; failure yields null-field defaults so the shape never changes. */
function mapLivePr(result: PromiseSettledResult<LivePrItem>): PrLiveDetails {
  const empty: PrLiveDetails = {
    head_ref: null, head_sha: null, base_ref: null, base_sha: null, draft: null, merged_by: null,
    author_avatar_url: null, assignees: [], requested_reviewers: [], requested_teams: [],
    milestone: null, labels: [],
  };
  if (result.status !== "fulfilled") return empty;
  const live = result.value;
  return {
    head_ref: live.head?.ref ?? null,
    head_sha: live.head?.sha ?? null,
    base_ref: live.base?.ref ?? null,
    base_sha: live.base?.sha ?? null,
    draft: live.draft ?? null,
    merged_by: mapPerson(live.merged_by),
    author_avatar_url: live.user?.avatar_url ?? null,
    assignees: (live.assignees ?? []).map((user) => ({ login: user.login, avatar_url: user.avatar_url ?? null })),
    requested_reviewers: (live.requested_reviewers ?? []).map((user) => ({ login: user.login, avatar_url: user.avatar_url ?? null })),
    requested_teams: (live.requested_teams ?? []).map((team) => ({ slug: team.slug, name: team.name ?? null })),
    milestone: live.milestone ? { title: live.milestone.title, url: live.milestone.html_url ?? null, due_on: live.milestone.due_on ?? null } : null,
    labels: (live.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null, description: label.description ?? null })),
  };
}

// ---------------------------------------------------------------------------
// PR checks / mergeability passthrough (XTRM-404)
// ---------------------------------------------------------------------------

export type PrCheckItem = { name: string; status: string | null; conclusion: string | null; url: string | null; source: "check_run" | "status" };
export type PrChecksPayload = {
  state: "success" | "failure" | "pending" | "none";
  checks: PrCheckItem[];
  head_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string | null;
  cached_at?: string;
};

const prChecksCache = new Map<string, { value: PrChecksPayload; expires: number }>();

export function clearPrChecksCache(): void {
  prChecksCache.clear();
}

export class GithubApiStatusError extends Error {
  constructor(readonly status: number, path: string) {
    super(`GitHub API error ${status}: ${path}`);
  }
}

/** GET that surfaces the HTTP status instead of collapsing it into a throw. */
export async function githubApiGetResponse(path: string, signal?: AbortSignal): Promise<Response> {
  const credential = await resolveGithubCredential();
  if (!credential.token) throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
  return await fetch(`${githubApiBaseUrl()}${path}`, {
    signal,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge/0.1.0",
    },
  });
}

type LivePullRequest = { head: { sha: string } | null; mergeable: boolean | null; mergeable_state: string | null; state: string };
type CheckRunsResponse = { total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }> };
type CommitStatusResponse = { state: string; statuses: Array<{ context: string; state: string; target_url: string | null }> };

/**
 * Aggregate check runs and commit statuses for a PR head, plus live
 * mergeability. Cached with the same TTL shape as the PR detail payload.
 */
export async function getPrChecksPayload(
  repo: string,
  number: number,
  pr: GithubPr,
  emitCacheEvent?: (event: PrDetailCacheEvent) => void,
): Promise<PrChecksPayload> {
  const cacheKey = `checks:${repo}#${number}:${pr.updated_at ?? pr.created_at}`;
  const cached = prChecksCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expires > now) {
    emitCacheEvent?.({ repo, number, hit: true });
    return { ...cached.value, cached_at: new Date(now).toISOString() };
  }
  emitCacheEvent?.({ repo, number, hit: false });

  const live = await fetchLivePullRequest(repo, number);
  if (!live) throw new GithubApiStatusError(404, `/repos/${repo}/pulls/${number}`);
  const headSha = live.head?.sha ?? null;

  const [checkRunsResult, statusesResult] = await Promise.allSettled([
    headSha ? withTimeout("check_runs", (signal) => githubApi<CheckRunsResponse>(`/repos/${repo}/commits/${headSha}/check-runs`, signal)) : Promise.resolve(null),
    headSha ? withTimeout("statuses", (signal) => githubApi<CommitStatusResponse>(`/repos/${repo}/commits/${headSha}/status`, signal)) : Promise.resolve(null),
  ]);

  const checks: PrCheckItem[] = [];
  if (checkRunsResult.status === "fulfilled" && checkRunsResult.value) {
    for (const run of checkRunsResult.value.check_runs ?? []) {
      checks.push({ name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, source: "check_run" });
    }
  }
  if (statusesResult.status === "fulfilled" && statusesResult.value) {
    for (const status of statusesResult.value.statuses ?? []) {
      checks.push({ name: status.context, status: "completed", conclusion: status.state, url: status.target_url, source: "status" });
    }
  }

  const payload: PrChecksPayload = {
    state: aggregateChecksState(checks),
    checks,
    head_sha: headSha,
    mergeable: live.mergeable,
    mergeable_state: live.mergeable_state,
  };

  if (checkRunsResult.status === "fulfilled" && statusesResult.status === "fulfilled") {
    prChecksCache.set(cacheKey, { value: payload, expires: Date.now() + (pr.state === "open" ? OPEN_PR_DETAIL_CACHE_TTL_MS : CLOSED_PR_DETAIL_CACHE_TTL_MS) });
    prunePrChecksCache();
  }
  return payload;
}

async function fetchLivePullRequest(repo: string, number: number): Promise<LivePullRequest | null> {
  const response = await githubApiGetResponse(`/repos/${repo}/pulls/${number}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubApiStatusError(response.status, `/repos/${repo}/pulls/${number}`);
  let live = await response.json() as LivePullRequest;
  if (live.mergeable === null) {
    // GitHub computes mergeability lazily; one bounded retry.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const retry = await githubApiGetResponse(`/repos/${repo}/pulls/${number}`);
    if (retry.ok) live = await retry.json() as LivePullRequest;
  }
  return live;
}

const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "error"]);
const PENDING_CONCLUSIONS = new Set(["pending", "expected"]);
const PENDING_STATUSES = new Set(["queued", "in_progress", "waiting_pending", "waiting", "pending"]);

export function aggregateChecksState(checks: PrCheckItem[]): "success" | "failure" | "pending" | "none" {
  if (checks.length === 0) return "none";
  let pending = false;
  for (const check of checks) {
    const conclusion = check.conclusion;
    if (conclusion && FAILURE_CONCLUSIONS.has(conclusion)) return "failure";
    if ((conclusion && PENDING_CONCLUSIONS.has(conclusion)) || (check.status && PENDING_STATUSES.has(check.status))) pending = true;
  }
  return pending ? "pending" : "success";
}

function prunePrChecksCache(): void {
  const now = Date.now();
  for (const [key, entry] of prChecksCache) {
    if (entry.expires <= now) prChecksCache.delete(key);
  }
  while (prChecksCache.size > MAX_PR_DETAIL_CACHE_ENTRIES) {
    const oldest = prChecksCache.keys().next().value;
    if (oldest === undefined) return;
    prChecksCache.delete(oldest);
  }
}
