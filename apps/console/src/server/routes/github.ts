import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import { isAllowedConsoleWriteRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import {
  enrichCommitMessages,
  getCommit,
  getCommits,
  getContributions,
  getEvent,
  getEvents,
  getIssue,
  getIssues,
  getPr,
  getPrs,
  getReleases,
  getRepoStats,
  getRepos,
  getSummary,
  getGithubToken,
  isAllowedMarkdownPath,
  isAllowedReportFilename,
  isKnownGithubRepo,
  getMarkdownFile,
  getPrDetailPayload,
  getReportFile,
  getReportSummaries,
  updateRepo,
  upsertRepo,
} from "../../../../../packages/core/src/github/index.ts";

export type GithubRouteLogger = {
  emit(entry: LogEntry): void;
};
export type GithubRouteLogSink = GithubRouteLogger | ((entry: LogEntry) => void);

/**
 * The publisher/registry argument is retained for Gitboard callers. HTTP
 * routes do not publish realtime events; the poller owns that responsibility.
 */
export function createGithubRouter(
  db: Database,
  publisherOrRegistry?: unknown,
  logger?: GithubRouteLogSink,
): Hono {
  const app = new Hono();
  const logSink = resolveLogSink(publisherOrRegistry, logger);

  app.get("/events", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const repos = q.repos ? q.repos.split(",").map((r) => r.trim()) : undefined;
    const types = q.types ? q.types.split(",").map((t) => t.trim()) : undefined;
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const events = getEvents(db, {
      repos, types, branch: q.branch, from: q.from, to: q.to, search: q.search, group: q.group, limit, offset,
    });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: events, limit, offset });
    emitLog(logSink, "github.events.timing", { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: events.length });
    return response;
  });

  app.get("/events/:id", (c) => {
    const event = getEvent(db, c.req.param("id"));
    if (!event) return c.json({ error: "not found" }, 404);
    return c.json(event);
  });

  app.get("/commits", async (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const commits = getCommits(db, { repo: q.repo, event_id: q.event_id, from: q.from, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    try {
      await enrichCommitMessages(db, commits, getGithubToken());
    } catch {
      // No token or network error: return the stored truncated messages.
    }
    emitLog(logSink, "github.commits.timing", { dbMs, totalMs: Math.round(performance.now() - t0), rows: commits.length });
    return c.json({ data: commits, limit, offset });
  });

  app.get("/repos/stats", (c) => c.json({ data: getRepoStats(db) }));

  app.get("/commits/:sha", (c) => {
    const commit = getCommit(db, c.req.param("sha"));
    if (!commit) return c.json({ error: "not found" }, 404);
    return c.json(commit);
  });

  app.get("/repos", (c) => {
    const t0 = performance.now();
    const repos = getRepos(db);
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: repos });
    emitLog(logSink, "github.repos.timing", { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: repos.length });
    return response;
  });

  app.post("/repos", async (c) => {
    if (!isGithubWriteAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.full_name !== "string") return c.json({ error: "full_name is required" }, 400);
    upsertRepo(db, {
      full_name: body.full_name,
      display_name: body.display_name ?? null,
      tracked: body.tracked ?? true,
      group_name: body.group_name ?? null,
      last_polled_at: null,
      color: body.color ?? null,
    });
    const repo = getRepos(db).find((item) => item.full_name === body.full_name);
    return c.json(repo, 201);
  });

  app.put("/repos/:name", async (c) => {
    if (!isGithubWriteAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const name = decodeURIComponent(c.req.param("name"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid body" }, 400);
    if (!getRepos(db).some((repo) => repo.full_name === name)) return c.json({ error: "not found" }, 404);
    updateRepo(db, name, { display_name: body.display_name, tracked: body.tracked, group_name: body.group_name, color: body.color });
    return c.json(getRepos(db).find((repo) => repo.full_name === name));
  });

  app.delete("/repos/:name", (c) => {
    if (!isGithubWriteAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const name = decodeURIComponent(c.req.param("name"));
    if (!getRepos(db).some((repo) => repo.full_name === name)) return c.json({ error: "not found" }, 404);
    updateRepo(db, name, { tracked: false });
    return c.json({ deleted: name });
  });

  app.get("/contributions", (c) => {
    const weeks = c.req.query("weeks") ? parseInt(c.req.query("weeks")!, 10) : 12;
    return c.json({ data: getContributions(db, weeks) });
  });

  app.get("/summary", (c) => {
    const validPeriods = ["today", "week", "month"] as const;
    type Period = (typeof validPeriods)[number];
    const requested = c.req.query("period") as Period;
    const period = validPeriods.includes(requested) ? requested : "today";
    return c.json(getSummary(db, period));
  });

  app.get("/prs", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const prs = getPrs(db, { repo: q.repo, state: q.state, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: prs, limit, offset });
    emitLog(logSink, "github.prs.timing", { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: prs.length });
    return response;
  });

  app.get("/releases", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 50;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const releases = getReleases(db, { repo: q.repo, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ releases });
    emitLog(logSink, "github.releases.timing", { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: releases.length });
    return response;
  });

  app.get("/prs/:owner/:repo/:number/detail", async (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const number = parseInt(c.req.param("number"), 10);
    const pr = getPr(db, repo, number);
    if (!pr) return c.json({ error: "not found" }, 404);
    const payload = await getPrDetailPayload(
      repo,
      number,
      pr,
      (event) => emitLog(logSink, "github.pr_detail.cache", event),
      (event) => emitLog(logSink, "github.pr_detail.timing", event),
    );
    return c.json(payload);
  });

  app.get("/prs/:owner/:repo/:number", (c) => {
    const pr = getPr(db, `${c.req.param("owner")}/${c.req.param("repo")}`, parseInt(c.req.param("number"), 10));
    if (!pr) return c.json({ error: "not found" }, 404);
    return c.json(pr);
  });

  app.get("/issues", (c) => {
    const t0 = performance.now();
    const q = c.req.query();
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const issues = getIssues(db, { repo: q.repo, state: q.state, limit, offset });
    const dbMs = Math.round(performance.now() - t0);
    const serializeStart = performance.now();
    const response = c.json({ data: issues, limit, offset });
    emitLog(logSink, "github.issues.timing", { dbMs, serializeMs: Math.round(performance.now() - serializeStart), rows: issues.length });
    return response;
  });

  app.get("/issues/:owner/:repo/:number", (c) => {
    const issue = getIssue(db, `${c.req.param("owner")}/${c.req.param("repo")}`, parseInt(c.req.param("number"), 10));
    if (!issue) return c.json({ error: "not found" }, 404);
    return c.json(issue);
  });

  app.get("/repo/:owner/:name/markdown", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const path = c.req.query("path") || "README.md";
    if (!isAllowedMarkdownPath(path)) return c.json({ error: "invalid path" }, 400);
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      const file = await getMarkdownFile(owner, name, path);
      return c.json(file ?? { content: null, sha: null, last_modified: null });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "fetch failed" }, 502);
    }
  });

  app.get("/repo/:owner/:name/reports", async (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!isKnownGithubRepo(db, owner, name)) return c.json({ error: "not found" }, 404);
    try {
      return c.json({ data: await getReportSummaries(owner, name) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "fetch failed" }, 502);
    }
  });

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
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "fetch failed" }, 502);
    }
  });

  return app;
}

function resolveLogSink(publisherOrRegistry: unknown, logger?: GithubRouteLogSink): GithubRouteLogSink | undefined {
  if (logger) return logger;
  if (typeof publisherOrRegistry === "function") return publisherOrRegistry as (entry: LogEntry) => void;
  if (publisherOrRegistry && typeof publisherOrRegistry === "object" && "emit" in publisherOrRegistry && typeof publisherOrRegistry.emit === "function") {
    return publisherOrRegistry as GithubRouteLogger;
  }
  return undefined;
}

function isGithubWriteAllowed(request: { url: string; header(name: string): string | undefined }): boolean {
  return isAllowedConsoleWriteRequest(
    request.url,
    request.header("host") ?? "",
    request.header("origin") ?? null,
    request.header("x-console-write-token") ?? request.header("x-gitboard-sources-admin-token") ?? null,
    process.env,
    request.header(TRUSTED_PEER_ADDRESS_HEADER),
  );
}

function emitLog(sink: GithubRouteLogSink | undefined, event: string, data?: Record<string, unknown>): void {
  if (!sink) return;
  const entry = makeLogEntry("api", event, "info", undefined, data);
  if (typeof sink === "function") sink(entry);
  else sink.emit(entry);
}
