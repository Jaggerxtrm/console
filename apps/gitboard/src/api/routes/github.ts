import { Hono } from "hono";
import { emit, makeLogEntry } from "../../core/logger.ts";
import type { Database } from "bun:sqlite";
import {
  getEvents,
  getEvent,
  getCommits,
  getCommit,
  getRepos,
  upsertRepo,
  updateRepo,
  getContributions,
  getSummary,
  getRepoStats,
  enrichCommitMessages,
  getPrs,
  getPr,
  getIssues,
  getIssue,
  getReleases,
} from "../../core/github-store.ts";
import { fetchRepoFile, listRepoDir } from "../../core/github-readme.ts";
import type { ChannelRegistry } from "../ws/channels.ts";
import type { GithubPr as StoreGithubPr } from "../../core/github-store.ts";

async function githubApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = resolveToken();
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

async function githubApiPages<T>(path: string, maxPages = 3, signal?: AbortSignal): Promise<T[]> {
  const results: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`, signal);
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

type PrDetailPayload = {
  pr: StoreGithubPr;
  comments: Array<{ id: number; author: string; body: string; url: string | null; created_at: string; updated_at: string | null }>;
  reviews: Array<{ id: number; author: string; state: string; body: string | null; url: string | null; submitted_at: string | null }>;
  review_comments: Array<{ id: number; author: string; body: string; path: string | null; line: number | null; diff_hunk: string | null; url: string | null; created_at: string; updated_at: string | null }>;
  commits: Array<{ sha: string; message: string; author: string; url: string | null; committed_at: string }>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string | null }>;
  timeline: Array<{ id: string; event: string; actor: string | null; body: string | null; commit_id: string | null; state: string | null; url: string | null; created_at: string }>;
  errors: Record<string, string>;
  cached_at?: string;
};

const OPEN_PR_DETAIL_CACHE_TTL_MS = 60 * 1000;
const CLOSED_PR_DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PR_DETAIL_CACHE_ENTRIES = 200;
const prDetailCache = new Map<string, { value: PrDetailPayload; expires: number }>();

function prDetailCacheKey(repo: string, number: number, updatedAt: string | null | undefined): string {
  return `${repo}#${number}:${updatedAt ?? "unknown"}`;
}

function prDetailCacheTtl(pr: StoreGithubPr): number {
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

function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = Bun.spawnSync(['gh', 'auth', 'token']);
  if (r.exitCode === 0) return r.stdout.toString().trim();
  throw new Error('No GitHub token');
}

function isAllowedMarkdownPath(path: string): boolean {
  return path === "README.md" || path === "CHANGELOG.md";
}

function isKnownGithubRepo(db: Database, owner: string, name: string): boolean {
  const fullName = `${owner}/${name}`;
  return getRepos(db).some((repo) => repo.full_name === fullName);
}

export function createGithubRouter(db: Database, registry: ChannelRegistry): Hono {
  const app = new Hono();

  // GET /api/github/events
  app.get("/events", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const repos = q.repos ? q.repos.split(",").map((r) => r.trim()) : undefined;
    const types = q.types ? q.types.split(",").map((t) => t.trim()) : undefined;
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;

    const events = getEvents(db, {
      repos,
      types,
      branch: q.branch,
      from: q.from,
      to: q.to,
      search: q.search,
      group: q.group,
      limit,
      offset,
    });

    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: events, limit, offset });
    emit(makeLogEntry("api", "github.events.timing", "info", undefined, { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: events.length }));
    return response;
  });

  // GET /api/github/events/:id
  app.get("/events/:id", (c) => {
    const id = c.req.param("id");
    const event = getEvent(db, id);
    if (!event) return c.json({ error: "not found" }, 404);
    return c.json(event);
  });

  // GET /api/github/commits
  app.get("/commits", async (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;

    const commits = getCommits(db, {
      repo: q.repo,
      event_id: q.event_id,
      from: q.from,
      limit,
      offset,
    });

    const dbMs = Math.round(performance.now() - t0);
    try {
      const token = resolveToken();
      await enrichCommitMessages(db, commits, token);
    } catch {
      // No token or network error — return commits as-is with truncated messages
    }

    emit(makeLogEntry("api", "github.commits.timing", "info", undefined, { dbMs, totalMs: Math.round(performance.now() - t0), rows: commits.length }));
    return c.json({ data: commits, limit, offset });
  });

  // GET /api/github/repos/stats
  app.get("/repos/stats", (c) => {
    const stats = getRepoStats(db);
    return c.json({ data: stats });
  });

  // GET /api/github/commits/:sha
  app.get("/commits/:sha", (c) => {
    const sha = c.req.param("sha");
    const commit = getCommit(db, sha);
    if (!commit) return c.json({ error: "not found" }, 404);
    return c.json(commit);
  });

  // GET /api/github/repos
  app.get("/repos", (c) => {
    const t0 = performance.now();
    const repos = getRepos(db);
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: repos });
    emit(makeLogEntry("api", "github.repos.timing", "info", undefined, { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: repos.length }));
    return response;
  });

  // POST /api/github/repos
  app.post("/repos", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.full_name !== "string") {
      return c.json({ error: "full_name is required" }, 400);
    }

    upsertRepo(db, {
      full_name: body.full_name,
      display_name: body.display_name ?? null,
      tracked: body.tracked ?? true,
      group_name: body.group_name ?? null,
      last_polled_at: null,
      color: body.color ?? null,
    });

    const repos = getRepos(db);
    const repo = repos.find((r) => r.full_name === body.full_name);
    return c.json(repo, 201);
  });

  // PUT /api/github/repos/:name
  app.put("/repos/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid body" }, 400);

    const repos = getRepos(db);
    const existing = repos.find((r) => r.full_name === name);
    if (!existing) return c.json({ error: "not found" }, 404);

    updateRepo(db, name, {
      display_name: body.display_name,
      tracked: body.tracked,
      group_name: body.group_name,
      color: body.color,
    });

    const updated = getRepos(db).find((r) => r.full_name === name);
    return c.json(updated);
  });

  // DELETE /api/github/repos/:name
  app.delete("/repos/:name", (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const repos = getRepos(db);
    const existing = repos.find((r) => r.full_name === name);
    if (!existing) return c.json({ error: "not found" }, 404);

    updateRepo(db, name, { tracked: false });
    return c.json({ deleted: name });
  });

  // GET /api/github/contributions
  app.get("/contributions", (c) => {
    const q = c.req.query();
    const weeks = q.weeks ? parseInt(q.weeks, 10) : 12;
    const contributions = getContributions(db, weeks);
    return c.json({ data: contributions });
  });

  // GET /api/github/summary
  app.get("/summary", (c) => {
    const q = c.req.query();
    const validPeriods = ["today", "week", "month"] as const;
    type Period = typeof validPeriods[number];
    const period: Period = validPeriods.includes(q.period as Period)
      ? (q.period as Period)
      : "today";
    const summary = getSummary(db, period);
    return c.json(summary);
  });

  // GET /api/github/prs
  app.get("/prs", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const prs = getPrs(db, { repo: q.repo, state: q.state, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: prs, limit, offset });
    emit(makeLogEntry("api", "github.prs.timing", "info", undefined, { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: prs.length }));
    return response;
  });

  // GET /api/github/releases — optional ?repo filter, mirrors /prs and /issues
  app.get("/releases", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const releases = getReleases(db, { repo: q.repo, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ releases });
    emit(makeLogEntry("api", "github.releases.timing", "info", undefined, { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: releases.length }));
    return response;
  });

  // GET /api/github/prs/:owner/:repo/:number/detail
  app.get("/prs/:owner/:repo/:number/detail", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = parseInt(c.req.param("number"), 10);
    const pr = getPr(db, repo, number);
    if (!pr) return c.json({ error: "not found" }, 404);

    const totalStart = performance.now();
    const cacheKey = prDetailCacheKey(repo, number, pr.updated_at ?? pr.created_at);
    const cached = prDetailCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expires > now) {
      emit(makeLogEntry("api", "github.pr_detail.cache", "info", undefined, { repo, number, hit: true }));
      return c.json({ ...cached.value, cached_at: new Date(now).toISOString() });
    }
    emit(makeLogEntry("api", "github.pr_detail.cache", "info", undefined, { repo, number, hit: false }));

    type CommentItem = { id: number; user: { login: string } | null; body: string; html_url: string | null; created_at: string; updated_at: string | null };
    type ReviewItem = { id: number; user: { login: string } | null; state: string; body: string | null; html_url: string | null; submitted_at: string | null };
    type ReviewCommentItem = { id: number; user: { login: string } | null; body: string; path: string | null; line: number | null; diff_hunk: string | null; html_url: string | null; created_at: string; updated_at: string | null };
    type CommitItem = { sha: string; html_url: string | null; commit: { message: string; author: { name: string; date: string } | null } };
    type FileItem = { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string | null };
    type TimelineItem = { id?: number | string; event?: string; actor?: { login: string } | null; user?: { login: string } | null; body?: string | null; commit_id?: string | null; state?: string | null; html_url?: string | null; created_at?: string; submitted_at?: string };

    const [commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult] = await Promise.allSettled([
      withTimeout("comments", (signal) => githubApiPages<CommentItem>(`/repos/${repo}/issues/${number}/comments`, 3, signal)),
      withTimeout("reviews", (signal) => githubApiPages<ReviewItem>(`/repos/${repo}/pulls/${number}/reviews`, 3, signal)),
      withTimeout("review_comments", (signal) => githubApiPages<ReviewCommentItem>(`/repos/${repo}/pulls/${number}/comments`, 3, signal)),
      withTimeout("commits", (signal) => githubApiPages<CommitItem>(`/repos/${repo}/pulls/${number}/commits`, 3, signal)),
      withTimeout("files", (signal) => githubApiPages<FileItem>(`/repos/${repo}/pulls/${number}/files`, 3, signal)),
      withTimeout("timeline", (signal) => githubApiPages<TimelineItem>(`/repos/${repo}/issues/${number}/timeline`, 3, signal)),
    ]);

    const errors: Record<string, string> = {};
    const collectError = (key: string, result: PromiseSettledResult<unknown>) => {
      if (result.status === "rejected") errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    };
    collectError("comments", commentsResult);
    collectError("reviews", reviewsResult);
    collectError("review_comments", reviewCommentsResult);
    collectError("commits", commitsResult);
    collectError("files", filesResult);
    collectError("timeline", timelineResult);

    const comments = commentsResult.status === "fulfilled" ? commentsResult.value.map((item) => ({
      id: item.id,
      author: item.user?.login ?? "unknown",
      body: item.body,
      url: item.html_url,
      created_at: item.created_at,
      updated_at: item.updated_at,
    })) : [];

    const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value.map((item) => ({
      id: item.id,
      author: item.user?.login ?? "unknown",
      state: item.state,
      body: item.body,
      url: item.html_url,
      submitted_at: item.submitted_at,
    })) : [];

    const review_comments = reviewCommentsResult.status === "fulfilled" ? reviewCommentsResult.value.map((item) => ({
      id: item.id,
      author: item.user?.login ?? "unknown",
      body: item.body,
      path: item.path,
      line: item.line,
      diff_hunk: item.diff_hunk,
      url: item.html_url,
      created_at: item.created_at,
      updated_at: item.updated_at,
    })) : [];

    const commits = commitsResult.status === "fulfilled" ? commitsResult.value.map((item) => ({
      sha: item.sha,
      message: item.commit.message.split("\n")[0],
      author: item.commit.author?.name ?? "unknown",
      url: item.html_url,
      committed_at: item.commit.author?.date ?? pr.updated_at ?? pr.created_at,
    })) : [];

    const files = filesResult.status === "fulfilled" ? filesResult.value.map((item) => ({
      filename: item.filename,
      status: item.status,
      additions: item.additions,
      deletions: item.deletions,
      changes: item.changes,
      patch: item.patch ?? null,
    })) : [];

    const timeline = timelineResult.status === "fulfilled" ? timelineResult.value
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
      })) : [];

    const payload: PrDetailPayload = { pr, comments, reviews, review_comments, commits, files, timeline, errors };
    if (Object.keys(errors).length === 0) {
      prDetailCache.set(cacheKey, { value: payload, expires: Date.now() + prDetailCacheTtl(pr) });
      prunePrDetailCache();
    }
    emit(makeLogEntry("api", "github.pr_detail.timing", "info", undefined, {
      repo,
      number,
      totalMs: Math.round(performance.now() - totalStart),
      commentsMs: commentsResult.status === "fulfilled" ? undefined : null,
      errors: Object.keys(errors).length,
    }));
    return c.json(payload);
  });

  // GET /api/github/prs/:owner/:repo/:number
  app.get("/prs/:owner/:repo/:number", (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = parseInt(c.req.param("number"), 10);
    const pr = getPr(db, repo, number);
    if (!pr) return c.json({ error: "not found" }, 404);
    return c.json(pr);
  });

  // GET /api/github/issues
  app.get("/issues", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const issues = getIssues(db, { repo: q.repo, state: q.state, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: issues, limit, offset });
    emit(makeLogEntry("api", "github.issues.timing", "info", undefined, { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: issues.length }));
    return response;
  });

  // GET /api/github/issues/:owner/:repo/:number
  app.get("/issues/:owner/:repo/:number", (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = parseInt(c.req.param("number"), 10);
    const issue = getIssue(db, repo, number);
    if (!issue) return c.json({ error: "not found" }, 404);
    return c.json(issue);
  });

  // GET /api/github/repo/:owner/:name/markdown?path=README.md|CHANGELOG.md
  app.get("/repo/:owner/:name/markdown", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const path = c.req.query("path") || "README.md";
    if (!isAllowedMarkdownPath(path)) return c.json({ error: "invalid path" }, 400);
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      const file = await fetchRepoFile(owner, name, path);
      if (!file) return c.json({ content: null, sha: null, last_modified: null }, 200);
      return c.json(file);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  // GET /api/github/repo/:owner/:name/reports
  app.get("/repo/:owner/:name/reports", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      const entries = await listRepoDir(owner, name, ".xtrm/reports");
      const reports = entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .sort((a, b) => b.name.localeCompare(a.name));

      return c.json({
        data: reports.map((r) => ({ name: r.name, path: r.path, sha: r.sha, size: r.size, frontmatter: null })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  // GET /api/github/repo/:owner/:name/reports/:filename
  app.get("/repo/:owner/:name/reports/:filename", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    if (!/^[\w.-]+\.md$/.test(filename)) return c.json({ error: "invalid filename" }, 400);
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      const file = await fetchRepoFile(owner, name, `.xtrm/reports/${filename}`);
      if (!file) return c.json({ error: "not found" }, 404);
      return c.json(file);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  return app;
}
