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
import {
  getMarkdownFile,
  getPrDetailPayload,
  getReportFile,
  getReportSummaries,
  isAllowedMarkdownPath,
  isAllowedReportFilename,
  isKnownGithubRepo,
} from "../../core/github-store.ts";
import { getGithubToken } from "../../core/github-store.ts";
import type { ChannelRegistry } from "../ws/channels.ts";

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
      const token = getGithubToken();
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

    const payload = await getPrDetailPayload(
      repo,
      number,
      pr,
      (event) => emit(makeLogEntry("api", "github.pr_detail.cache", "info", undefined, event)),
      (event) => emit(makeLogEntry("api", "github.pr_detail.timing", "info", undefined, event)),
    );
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
      const file = await getMarkdownFile(owner, name, path);
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
      const reports = await getReportSummaries(owner, name);
      return c.json({ data: reports });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  // GET /api/github/repo/:owner/:name/reports/:filename
  app.get("/repo/:owner/:name/reports/:filename", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    if (!isAllowedReportFilename(filename)) return c.json({ error: "invalid filename" }, 400);
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      const file = await getReportFile(owner, name, filename);
      if (!file) return c.json({ error: "not found" }, 404);
      return c.json(file);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
    }
  });

  return app;
}
