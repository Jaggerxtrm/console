import { Hono } from "hono";
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
import { fetchRepoFile, listRepoDir, parseFrontmatter } from "../../core/github-readme.ts";
import type { ChannelRegistry } from "../ws/channels.ts";

async function githubApi<T>(path: string): Promise<T> {
  const token = resolveToken();
  const response = await fetch(`https://api.github.com${path}`, {
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

async function githubApiPages<T>(path: string, maxPages = 3): Promise<T[]> {
  const results: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubApi<T[]>(`${path}${separator}per_page=100&page=${page}`);
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = Bun.spawnSync(['gh', 'auth', 'token']);
  if (r.exitCode === 0) return r.stdout.toString().trim();
  throw new Error('No GitHub token');
}

export function createGithubRouter(db: Database, registry: ChannelRegistry): Hono {
  const app = new Hono();

  // GET /api/github/events
  app.get("/events", (c) => {
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

    return c.json({ data: events, limit, offset });
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

    // Lazy-enrich truncated commit messages from GitHub API
    try {
      const token = resolveToken();
      await enrichCommitMessages(db, commits, token);
    } catch {
      // No token or network error — return commits as-is with truncated messages
    }

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
    const repos = getRepos(db);
    return c.json({ data: repos });
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
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const prs = getPrs(db, { repo: q.repo, state: q.state, limit, offset });
    return c.json({ data: prs, limit, offset });
  });

  // GET /api/github/releases
  app.get("/releases", (c) => {
    const q = c.req.query();
    if (!q.repo) return c.json({ error: "repo is required" }, 400);
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const releases = getReleases(db, { repo: q.repo, limit, offset });
    return c.json({ releases });
  });

  // GET /api/github/prs/:owner/:repo/:number/detail
  app.get("/prs/:owner/:repo/:number/detail", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = parseInt(c.req.param("number"), 10);
    const pr = getPr(db, repo, number);
    if (!pr) return c.json({ error: "not found" }, 404);

    type CommentItem = { id: number; user: { login: string } | null; body: string; html_url: string | null; created_at: string; updated_at: string | null };
    type ReviewItem = { id: number; user: { login: string } | null; state: string; body: string | null; html_url: string | null; submitted_at: string | null };
    type ReviewCommentItem = { id: number; user: { login: string } | null; body: string; path: string | null; line: number | null; diff_hunk: string | null; html_url: string | null; created_at: string; updated_at: string | null };
    type CommitItem = { sha: string; html_url: string | null; commit: { message: string; author: { name: string; date: string } | null } };
    type FileItem = { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string | null };
    type TimelineItem = { id?: number | string; event?: string; actor?: { login: string } | null; user?: { login: string } | null; body?: string | null; commit_id?: string | null; state?: string | null; html_url?: string | null; created_at?: string; submitted_at?: string };

    const [commentsResult, reviewsResult, reviewCommentsResult, commitsResult, filesResult, timelineResult] = await Promise.allSettled([
      githubApiPages<CommentItem>(`/repos/${repo}/issues/${number}/comments`),
      githubApiPages<ReviewItem>(`/repos/${repo}/pulls/${number}/reviews`),
      githubApiPages<ReviewCommentItem>(`/repos/${repo}/pulls/${number}/comments`),
      githubApiPages<CommitItem>(`/repos/${repo}/pulls/${number}/commits`),
      githubApiPages<FileItem>(`/repos/${repo}/pulls/${number}/files`),
      githubApiPages<TimelineItem>(`/repos/${repo}/issues/${number}/timeline`),
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

    return c.json({ pr, comments, reviews, review_comments, commits, files, timeline, errors });
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
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const issues = getIssues(db, { repo: q.repo, state: q.state, limit, offset });
    return c.json({ data: issues, limit, offset });
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
    try {
      const entries = await listRepoDir(owner, name, ".xtrm/reports");
      const reports = entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .sort((a, b) => b.name.localeCompare(a.name));

      const withMeta = await Promise.all(
        reports.map(async (r) => {
          let frontmatter: Record<string, string> | null = null;
          try {
            const file = await fetchRepoFile(owner, name, r.path);
            if (file?.content) frontmatter = parseFrontmatter(file.content);
          } catch {
            /* skip per-file errors */
          }
          return { name: r.name, path: r.path, sha: r.sha, size: r.size, frontmatter };
        }),
      );
      return c.json({ data: withMeta });
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
