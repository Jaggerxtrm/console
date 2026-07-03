import type { Database } from "bun:sqlite";
import { fetchRepoFile, listRepoDir } from "./readme.ts";
import { getGithubToken } from "./token.ts";
import { getRepos, type GithubPr, type GithubRepo } from "./store.ts";

export type PrDetailPayload = {
  pr: GithubPr;
  comments: Array<{ id: number; author: string; body: string; url: string | null; created_at: string; updated_at: string | null }>;
  reviews: Array<{ id: number; author: string; state: string; body: string | null; url: string | null; submitted_at: string | null }>;
  review_comments: Array<{ id: number; author: string; body: string; path: string | null; line: number | null; diff_hunk: string | null; url: string | null; created_at: string; updated_at: string | null }>;
  commits: Array<{ sha: string; message: string; author: string; url: string | null; committed_at: string }>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string | null }>;
  timeline: Array<{ id: string; event: string; actor: string | null; body: string | null; commit_id: string | null; state: string | null; url: string | null; created_at: string }>;
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
  const token = getGithubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
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

  const [commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult] = await fetchPrDetailSections(repo, number);
  const errors = collectPrDetailErrors({ commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult });
  const payload: PrDetailPayload = {
    pr,
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

type CommentItem = { id: number; user: { login: string } | null; body: string; html_url: string | null; created_at: string; updated_at: string | null };
type ReviewItem = { id: number; user: { login: string } | null; state: string; body: string | null; html_url: string | null; submitted_at: string | null };
type ReviewCommentItem = { id: number; user: { login: string } | null; body: string; path: string | null; line: number | null; diff_hunk: string | null; html_url: string | null; created_at: string; updated_at: string | null };
type CommitItem = { sha: string; html_url: string | null; commit: { message: string; author: { name: string; date: string } | null } };
type FileItem = { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string | null };
type TimelineItem = { id?: number | string; event?: string; actor?: { login: string } | null; user?: { login: string } | null; body?: string | null; commit_id?: string | null; state?: string | null; html_url?: string | null; created_at?: string; submitted_at?: string };
type PrDetailSectionResults = readonly [
  PromiseSettledResult<CommentItem[]>,
  PromiseSettledResult<ReviewItem[]>,
  PromiseSettledResult<ReviewCommentItem[]>,
  PromiseSettledResult<CommitItem[]>,
  PromiseSettledResult<FileItem[]>,
  PromiseSettledResult<TimelineItem[]>,
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
  ]) as PrDetailSectionResults;
}

function collectPrDetailErrors(results: {
  commentsResult: PromiseSettledResult<unknown>;
  reviewsResult: PromiseSettledResult<unknown>;
  reviewCommentsResult: PromiseSettledResult<unknown>;
  commitsResult: PromiseSettledResult<unknown>;
  filesResult: PromiseSettledResult<unknown>;
  timelineResult: PromiseSettledResult<unknown>;
}): Record<string, string> {
  const entries: Array<readonly [string, PromiseSettledResult<unknown>]> = [
    ["comments", results.commentsResult],
    ["reviews", results.reviewsResult],
    ["review_comments", results.reviewCommentsResult],
    ["commits", results.commitsResult],
    ["files", results.filesResult],
    ["timeline", results.timelineResult],
  ];

  return Object.fromEntries(entries.flatMap(([key, result]) => {
    if (result.status !== "rejected") return [];
    return [[key, result.reason instanceof Error ? result.reason.message : String(result.reason)]];
  }));
}

function mapComments(result: PromiseSettledResult<CommentItem[]>): PrDetailPayload["comments"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ id: item.id, author: item.user?.login ?? "unknown", body: item.body, url: item.html_url, created_at: item.created_at, updated_at: item.updated_at }));
}

function mapReviews(result: PromiseSettledResult<ReviewItem[]>): PrDetailPayload["reviews"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ id: item.id, author: item.user?.login ?? "unknown", state: item.state, body: item.body, url: item.html_url, submitted_at: item.submitted_at }));
}

function mapReviewComments(result: PromiseSettledResult<ReviewCommentItem[]>): PrDetailPayload["review_comments"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ id: item.id, author: item.user?.login ?? "unknown", body: item.body, path: item.path, line: item.line, diff_hunk: item.diff_hunk, url: item.html_url, created_at: item.created_at, updated_at: item.updated_at }));
}

function mapCommits(result: PromiseSettledResult<CommitItem[]>, pr: GithubPr): PrDetailPayload["commits"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ sha: item.sha, message: item.commit.message.split("\n")[0], author: item.commit.author?.name ?? "unknown", url: item.html_url, committed_at: item.commit.author?.date ?? pr.updated_at ?? pr.created_at }));
}

function mapFiles(result: PromiseSettledResult<FileItem[]>): PrDetailPayload["files"] {
  if (result.status !== "fulfilled") return [];
  return result.value.map((item) => ({ filename: item.filename, status: item.status, additions: item.additions, deletions: item.deletions, changes: item.changes, patch: item.patch ?? null }));
}

function mapTimeline(result: PromiseSettledResult<TimelineItem[]>, pr: GithubPr): PrDetailPayload["timeline"] {
  if (result.status !== "fulfilled") return [];
  return result.value
    .filter((item) => item.event || item.body || item.state)
    .map((item, index) => ({
      id: String(item.id ?? `${item.event ?? "timeline"}-${index}`),
      event: item.event ?? (item.body ? "commented" : "activity"),
      actor: item.actor?.login ?? item.user?.login ?? null,
      body: item.body ?? null,
      commit_id: item.commit_id ?? null,
      state: item.state ?? null,
      url: item.html_url ?? null,
      created_at: item.created_at ?? item.submitted_at ?? pr.updated_at ?? pr.created_at,
    }));
}
