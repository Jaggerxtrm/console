/**
 * API routes for beads data
 */

import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { ProjectScanner } from "../../core/project-scanner.ts";
import { BeadsReader } from "../../core/beads-reader.ts";
import { DoltClient, doltPoolKey } from "../../core/dolt-client.ts";
import { emit, makeLogEntry } from "../../../../gitboard/src/core/logger.ts";
import type { BeadIssue, BeadIssueDetail, Memory, Interaction, ProjectSourceKind, BeadsProject } from "../../types/beads.ts";

let scanner: ProjectScanner | null = null;
const doltClients: Map<string, DoltClient> = new Map();
const sqliteReaders: Map<string, BeadsReader> = new Map();

function getScanner(): ProjectScanner {
  if (!scanner) {
    const searchPath = process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home");
    scanner = new ProjectScanner({
      searchPath,
      maxDepth: 3,
      excludePatterns: ["node_modules", ".git", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"],
    });
  }
  return scanner;
}

function getDoltClient(config: { host: string; port: number; database?: string; user?: string }): DoltClient {
  const key = doltPoolKey(config);
  if (!doltClients.has(key)) {
    doltClients.set(key, new DoltClient(config));
  }
  return doltClients.get(key)!;
}

function getSqliteReader(dbPath: string): BeadsReader {
  if (!sqliteReaders.has(dbPath)) {
    sqliteReaders.set(dbPath, new BeadsReader(new Database(dbPath)));
  }
  return sqliteReaders.get(dbPath)!;
}

function withProjectId<T extends { project_id: string }>(value: T, projectId: string): T {
  return { ...value, project_id: projectId };
}

function sourceOrder(projectSource: ProjectSourceKind): ProjectSourceKind[] {
  const order: ProjectSourceKind[] = ["dolt", "sqlite", "jsonl", "unknown"];
  return projectSource === "unknown" ? order : [projectSource, ...order.filter((source) => source !== projectSource)];
}

type DoltRuntimeInfo = { port?: number; pid?: number; pidAlive?: boolean };
type DoltFailureStatus = "dolt_missing_config" | "dolt_process_dead" | "dolt_unreachable" | "dolt_query_failed";

async function getDoltRuntime(project: BeadsProject): Promise<DoltRuntimeInfo> {
  const [portFile, pidFile] = await Promise.all([
    readOptionalNumber(`${project.beadsPath}/dolt-server.port`),
    readOptionalNumber(`${project.beadsPath}/dolt-server.pid`),
  ]);
  return {
    port: project.doltPort ?? portFile,
    pid: pidFile,
    pidAlive: pidFile ? isProcessAlive(pidFile) : undefined,
  };
}

async function readOptionalNumber(path: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt((await readFile(path, "utf-8")).trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyDoltError(error: unknown): DoltFailureStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|connect|timeout|circuit breaker/i.test(message)) return "dolt_unreachable";
  return "dolt_query_failed";
}

function degradedSource(project: BeadsProject, status: DoltFailureStatus, message: string, extra: Record<string, unknown> = {}) {
  const hasJsonl = project.sourceHealth?.some((entry) => entry.kind === "jsonl" && entry.state === "available") ?? false;
  const payload = {
    source: "jsonl",
    status,
    degraded: true,
    message: hasJsonl ? `${message}; reading JSONL backup. Data may be stale.` : message,
    note: hasJsonl ? "Dolt is unavailable; JSONL backup is not the source of truth." : "Dolt is unavailable and no JSONL backup was detected.",
    ...extra,
  };
  emit(makeLogEntry("dolt", "source.degraded", "warn", payload.message, { projectId: project.id, projectPath: project.path, status, ...extra }));
  return payload;
}

async function getProjectDoltClient(project: BeadsProject): Promise<{ client: DoltClient; runtime: DoltRuntimeInfo } | null> {
  const runtime = await getDoltRuntime(project);
  if (!runtime.port) return null;
  const host = process.env.DOLT_HOST ?? (process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1");
  return { client: getDoltClient({ host, port: runtime.port, database: project.doltDatabase ?? "dolt" }), runtime };
}

export const beadsRoutes = new Hono();

beadsRoutes.get("/projects", async (c) => {
  try {
    const projects = await Promise.race([
      getScanner().scanDirectory(),
      new Promise<[]>(resolve => setTimeout(() => resolve([]), 1000)),
    ]);
    return c.json({ projects });
  } catch (error) {
    console.error("[api] Error scanning projects:", error);
    return c.json({ error: "Failed to scan projects" }, 500);
  }
});

beadsRoutes.get("/projects/:id/issues", async (c) => {
  try {
    const projectId = c.req.param("id");
    const status = c.req.query("status")?.split(",") as BeadIssue["status"][] | undefined;
    const priority = c.req.query("priority")?.split(",").map(Number) as BeadIssue["priority"][] | undefined;
    const search = c.req.query("search");
    const limit = Number.parseInt(c.req.query("limit") || "100", 10);

    const issues = await getIssuesFromProject(projectId, { status, priority, search, limit });
    return c.json({ issues: issues.map((issue) => ({ ...issue, project_id: projectId })) });
  } catch (error) {
    console.error("[api] Error getting issues:", error);
    return c.json({ error: "Failed to get issues" }, 500);
  }
});

beadsRoutes.get("/projects/:id/issues/closed", async (c) => {
  try {
    const projectId = c.req.param("id");
    const limit = Number.parseInt(c.req.query("limit") || "50", 10);
    const issues = await getClosedIssuesFromProject(projectId, limit);
    return c.json({ issues: issues.map((issue) => ({ ...issue, project_id: projectId })) });
  } catch (error) {
    console.error("[api] Error getting closed issues:", error);
    return c.json({ error: "Failed to get closed issues" }, 500);
  }
});

beadsRoutes.get("/projects/:id/issues/:issueId", async (c) => {
  try {
    const projectId = c.req.param("id");
    const issueId = c.req.param("issueId");
    const detail = await getIssueDetailFromProject(projectId, issueId);

    if (!detail) return c.json({ error: "Issue not found" }, 404);
    return c.json({ issue: withProjectId(detail, projectId) });
  } catch (error) {
    console.error("[api] Error getting issue detail:", error);
    return c.json({ error: "Failed to get issue detail" }, 500);
  }
});

beadsRoutes.get("/projects/:id/memories", async (c) => {
  try {
    const projectId = c.req.param("id");
    const project = getScanner().getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const memories = await readJsonlMemories(`${project.beadsPath}/knowledge.jsonl`);
    return c.json({ memories: memories.map((memory) => withProjectId(memory, projectId)) });
  } catch (error) {
    console.error("[api] Error getting memories:", error);
    return c.json({ memories: [] });
  }
});

beadsRoutes.get("/projects/:id/interactions", async (c) => {
  try {
    const projectId = c.req.param("id");
    const issueId = c.req.query("issue_id");
    const project = getScanner().getProject(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);

    let interactions = await readJsonlInteractions(`${project.beadsPath}/interactions.jsonl`);
    interactions = interactions.map((interaction) => withProjectId(interaction, projectId));
    if (issueId) interactions = interactions.filter((interaction) => interaction.issue_id === issueId);
    return c.json({ interactions });
  } catch (error) {
    console.error("[api] Error getting interactions:", error);
    return c.json({ interactions: [] });
  }
});

beadsRoutes.get("/projects/:id/stats", async (c) => {
  try {
    const projectId = c.req.param("id");
    const stats = await getStatsFromProject(projectId);
    return c.json({ stats });
  } catch (error) {
    console.error("[api] Error getting stats:", error);
    return c.json({ error: "Failed to get stats" }, 500);
  }
});

beadsRoutes.get("/projects/:id/connection", async (c) => {
  const projectId = c.req.param("id");
  const project = getScanner().getProject(projectId);
  if (!project) return c.json({ source: "none", status: "not_found", degraded: true, message: "Project not found", error: "Project not found" });

  const dolt = await getProjectDoltClient(project);
  if (!dolt) {
    return c.json(degradedSource(project, "dolt_missing_config", "Dolt server port is missing", { configuredPort: project.doltPort ?? null }));
  }

  if (dolt.runtime.pid && dolt.runtime.pidAlive === false) {
    return c.json(degradedSource(project, "dolt_process_dead", "Dolt server pid is not running", { port: dolt.runtime.port, pid: dolt.runtime.pid }));
  }

  try {
    await dolt.client.connect();
    await dolt.client.getIssues({ limit: 1 });
    return c.json({
      source: "dolt",
      status: "dolt_connected",
      degraded: false,
      message: `Dolt connected on :${dolt.runtime.port}`,
      port: dolt.runtime.port,
      pid: dolt.runtime.pid,
      database: project.doltDatabase || "dolt",
    });
  } catch (error) {
    const status = classifyDoltError(error);
    const message = error instanceof Error ? error.message : "Unknown Dolt error";
    return c.json(degradedSource(project, status, "Dolt query failed", { port: dolt.runtime.port, pid: dolt.runtime.pid, error: message }));
  }
});

async function getIssuesFromProject(
  projectId: string,
  filters: { status?: BeadIssue["status"][]; priority?: BeadIssue["priority"][]; search?: string; limit?: number },
): Promise<BeadIssue[]> {
  const startedAt = performance.now();
  const project = getScanner().getProject(projectId);
  if (!project) return [];

  for (const source of sourceOrder(project.source ?? "unknown")) {
    if (source === "dolt") {
      const dolt = await getProjectDoltClient(project);
      if (!dolt) {
        degradedSource(project, "dolt_missing_config", "Dolt server port is missing");
        continue;
      }
      try {
        const issues = await dolt.client.getIssues(filters);
        emit(makeLogEntry("dolt", "beads.source.timing", "info", undefined, { projectId, source: "dolt", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
        return issues;
      } catch (error) {
        degradedSource(project, classifyDoltError(error), "Dolt query failed", { port: dolt.runtime.port, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    if (source === "sqlite") {
      const dbPath = (project.sourceHealth ?? []).find((entry) => entry.kind === "sqlite" && entry.path)?.path;
      if (!dbPath) continue;
      try {
        const issues = await getSqliteReader(dbPath).getIssues(filters);
        emit(makeLogEntry("api", "beads.source.timing", "info", undefined, { projectId, source: "sqlite", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
        return issues;
      } catch {
        continue;
      }
    }
  }

  const jsonlIssues = await readJsonlIssues(project.beadsPath, projectId);
  emit(makeLogEntry("api", "beads.source.timing", "info", undefined, { projectId, source: "jsonl", ms: Math.round(performance.now() - startedAt), rows: jsonlIssues.length }));
  return applyIssueFilters(jsonlIssues, filters);
}

async function getIssueDetailFromProject(projectId: string, issueId: string): Promise<BeadIssueDetail | null> {
  const startedAt = performance.now();
  const project = getScanner().getProject(projectId);
  if (!project) return null;

  for (const source of sourceOrder(project.source ?? "unknown")) {
    if (source === "dolt") {
      const dolt = await getProjectDoltClient(project);
      if (!dolt) {
        degradedSource(project, "dolt_missing_config", "Dolt server port is missing");
        continue;
      }
      try {
        const detail = await dolt.client.getIssue(issueId);
        if (detail) {
          emit(makeLogEntry("dolt", "beads.detail.timing", "info", undefined, { projectId, source: "dolt", ms: Math.round(performance.now() - startedAt), found: true }));
          return withProjectId(detail, projectId);
        }
      } catch (error) {
        degradedSource(project, classifyDoltError(error), "Dolt query failed", { port: dolt.runtime.port, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    if (source === "sqlite") {
      const dbPath = (project.sourceHealth ?? []).find((entry) => entry.kind === "sqlite" && entry.path)?.path;
      if (!dbPath) continue;
      try {
        const detail = await getSqliteReader(dbPath).getIssue(issueId);
        if (detail) {
          emit(makeLogEntry("api", "beads.detail.timing", "info", undefined, { projectId, source: "sqlite", ms: Math.round(performance.now() - startedAt), found: true }));
          return withProjectId(detail, projectId);
        }
      } catch {
        continue;
      }
    }
  }

  const jsonlIssues = await readJsonlIssues(project.beadsPath, projectId);
  const issue = jsonlIssues.find((candidate) => candidate.id === issueId);
  if (!issue) return null;
  const dependents = jsonlIssues.flatMap((candidate) =>
    candidate.dependencies
      .filter((dependency: BeadIssue["dependencies"][number]) => dependency.id === issueId)
      .map((dependency: BeadIssue["dependencies"][number]) => ({
        id: candidate.id,
        title: candidate.title,
        status: candidate.status,
        dependency_type: dependency.dependency_type,
      })),
  );

  emit(makeLogEntry("api", "beads.detail.timing", "info", undefined, { projectId, source: "jsonl", ms: Math.round(performance.now() - startedAt), found: true }));
  return {
    ...issue,
    dependents,
    children: dependents.filter((dependency) => dependency.dependency_type === "parent-child"),
    source: "jsonl",
    sourceHealth: [{ kind: "jsonl", state: "available", path: `${project.beadsPath}/issues.jsonl` }],
  };
}

async function getClosedIssuesFromProject(projectId: string, limit: number): Promise<BeadIssue[]> {
  const startedAt = performance.now();
  const project = getScanner().getProject(projectId);
  if (!project) return [];

  for (const source of sourceOrder(project.source ?? "unknown")) {
    if (source === "dolt") {
      const dolt = await getProjectDoltClient(project);
      if (!dolt) {
        degradedSource(project, "dolt_missing_config", "Dolt server port is missing");
        continue;
      }
      try {
        const issues = await dolt.client.getClosedIssues(limit);
        emit(makeLogEntry("dolt", "beads.closed.timing", "info", undefined, { projectId, source: "dolt", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
        return issues;
      } catch (error) {
        degradedSource(project, classifyDoltError(error), "Dolt query failed", { port: dolt.runtime.port, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    if (source === "sqlite") {
      const dbPath = (project.sourceHealth ?? []).find((entry) => entry.kind === "sqlite" && entry.path)?.path;
      if (!dbPath) continue;
      try {
        const issues = await getSqliteReader(dbPath).getClosedIssues(limit);
        emit(makeLogEntry("api", "beads.closed.timing", "info", undefined, { projectId, source: "sqlite", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
        return issues;
      } catch {
        continue;
      }
    }
  }

  const jsonlIssues = await readJsonlIssues(project.beadsPath, projectId);
  const issues = jsonlIssues
    .filter((issue) => issue.status === "closed")
    .sort((a, b) => new Date(b.closed_at || b.updated_at).getTime() - new Date(a.closed_at || a.updated_at).getTime())
    .slice(0, limit);
  emit(makeLogEntry("api", "beads.closed.timing", "info", undefined, { projectId, source: "jsonl", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
  return issues;
}

async function getStatsFromProject(projectId: string): Promise<{
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
}> {
  const startedAt = performance.now();
  const project = getScanner().getProject(projectId);
  if (!project) {
    return { total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0, by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }, by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 } };
  }

  const issues = await getIssuesFromProject(projectId, { limit: 1000 });
  type ProjectStats = {
    total: number;
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
    by_priority: Record<string, number>;
    by_type: Record<string, number>;
  };
  const stats = issues.reduce<ProjectStats>(
    (acc, issue) => {
      acc.total += 1;
      if (issue.status in acc) acc[issue.status as keyof Omit<ProjectStats, "by_priority" | "by_type">] += 1;
      const priorityKey = `p${issue.priority}`;
      acc.by_priority[priorityKey] = (acc.by_priority[priorityKey] ?? 0) + 1;
      const typeKey = issue.issue_type;
      acc.by_type[typeKey] = (acc.by_type[typeKey] ?? 0) + 1;
      return acc;
    },
    {
      total: 0,
      open: 0,
      in_progress: 0,
      blocked: 0,
      closed: 0,
      by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 },
      by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 },
    },
  );

  emit(makeLogEntry("api", "beads.stats.timing", "info", undefined, { projectId, ms: Math.round(performance.now() - startedAt), rows: issues.length }));
  return stats;
}

function applyIssueFilters(
  issues: BeadIssue[],
  filters: { status?: BeadIssue["status"][]; priority?: BeadIssue["priority"][]; search?: string; limit?: number },
): BeadIssue[] {
  let filtered = issues;
  if (filters.status?.length) filtered = filtered.filter((issue) => filters.status?.includes(issue.status));
  if (filters.priority?.length) filtered = filtered.filter((issue) => filters.priority?.includes(issue.priority));
  if (filters.search) {
    const search = filters.search.toLowerCase();
    filtered = filtered.filter((issue) => issue.title.toLowerCase().includes(search) || issue.description?.toLowerCase().includes(search) || issue.notes?.toLowerCase().includes(search));
  }
  return filtered.slice(0, filters.limit ?? 100);
}

async function readJsonlIssues(beadsPath: string, projectId: string): Promise<BeadIssue[]> {
  try {
    const content = await Bun.file(`${beadsPath}/issues.jsonl`).text();
    return content.split("\n").flatMap((line) => BeadsReader.parseIssueLine(line)).map((issue) => withProjectId(issue, projectId));
  } catch {
    return [];
  }
}

async function readJsonlMemories(path: string) {
  try {
    const content = await Bun.file(path).text();
    return content.split("\n").flatMap((line) => BeadsReader.parseMemoryLine(line));
  } catch {
    return [];
  }
}

async function readJsonlInteractions(path: string) {
  try {
    const content = await Bun.file(path).text();
    return content.split("\n").flatMap((line) => BeadsReader.parseInteractionLine(line));
  } catch {
    return [];
  }
}
