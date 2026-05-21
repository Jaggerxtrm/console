/**
 * API routes for beads data
 */

import { Hono } from "hono";
import { ProjectScanner } from "../../core/project-scanner.ts";
import { BeadsReader } from "../../core/beads-reader.ts";
import { DoltClient } from "../../core/dolt-client.ts";
import { readIssuesFromJsonl } from "../../core/jsonl-reader.ts";
import type { BeadIssue, BeadsProject } from "../../types/beads.ts";

// Singleton scanner with lazy initialization
let scannerInstance: ProjectScanner | null = null;
let scannerWarm: Promise<void> | null = null;

const projectCache = new Map<string, { value: unknown }>();

// Cache for dolt clients by port
const doltClients: Map<number, DoltClient> = new Map();

function getScanner(): ProjectScanner {
  if (!scannerInstance) {
    const searchPath = process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home");
    scannerInstance = new ProjectScanner({
      searchPath,
      maxDepth: 5,
      excludePatterns: ["node_modules", ".git", "Library", "Applications", ".cargo", ".npm", ".rustup"],
    });
  }
  if (!scannerWarm) scannerWarm = scannerInstance.scanDirectory().then(() => undefined).catch(() => undefined);
  return scannerInstance;
}

function getDoltClient(port: number): DoltClient {
  if (!doltClients.has(port)) {
    const host = process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1";
    doltClients.set(port, new DoltClient({ host, port }));
  }
  return doltClients.get(port)!;
}

function readCache<T>(key: string): T | null {
  const cached = projectCache.get(key);
  if (!cached) return null;
  return cached.value as T;
}

function writeCache<T>(key: string, value: T): void {
  projectCache.set(key, { value });
}

async function refreshProjects(scanner: ProjectScanner): Promise<void> {
  const projects = await scanner.scanDirectory().catch(() => [] as BeadsProject[]);
  writeCache("projects", { projects });
}

export const beadsRoutes = new Hono();

// Get all discovered projects
beadsRoutes.get("/projects", async (c) => {
  const scanner = getScanner();
  const cached = readCache<{ projects: BeadsProject[] }>("projects");
  if (cached) return c.json({ ...cached, freshness: "fresh" });

  void refreshProjects(scanner);
  return c.json({ projects: [], freshness: "stale" });
});

// Get issues for a project
beadsRoutes.get("/projects/:id/issues", async (c) => {
  try {
    const projectId = c.req.param("id");
    const status = c.req.query("status")?.split(",") as BeadIssue["status"][] | undefined;
    const priority = c.req.query("priority")?.split(",").map(Number) as BeadIssue["priority"][] | undefined;
    const search = c.req.query("search");
    const limit = parseInt(c.req.query("limit") || "100");

    const scanner = getScanner();
    let issues = await getIssues(scanner, projectId);

    // Apply filters
    if (status) {
      issues = issues.filter(i => status.includes(i.status));
    }
    if (priority) {
      issues = issues.filter(i => priority.includes(i.priority));
    }
    if (search) {
      const s = search.toLowerCase();
      issues = issues.filter(i => 
        i.title.toLowerCase().includes(s) || 
        i.description?.toLowerCase().includes(s)
      );
    }

    return c.json({ issues: issues.slice(0, limit).map(i => ({ ...i, project_id: projectId })) });
  } catch (error) {
    console.error("[api] Error getting issues:", error);
    return c.json({ error: "Failed to get issues" }, 500);
  }
});

// Get closed issues for a project
beadsRoutes.get("/projects/:id/issues/closed", async (c) => {
  try {
    const projectId = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "50");

    const scanner = getScanner();
    const issues = (await getIssues(scanner, projectId))
      .filter(i => i.status === "closed")
      .sort((a, b) => 
        new Date(b.closed_at || b.updated_at).getTime() - 
        new Date(a.closed_at || a.updated_at).getTime()
      )
      .slice(0, limit)
      .map(i => ({ ...i, project_id: projectId }));

    return c.json({ issues });
  } catch (error) {
    console.error("[api] Error getting closed issues:", error);
    return c.json({ error: "Failed to get closed issues" }, 500);
  }
});

// Get memories for a project
beadsRoutes.get("/projects/:id/memories", async (c) => {
  try {
    const projectId = c.req.param("id");
    const scanner = getScanner();
    const project = scanner.getProject(projectId);

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = new BeadsReader({} as any);
    const memories = await reader.getMemories(`${project.beadsPath}/knowledge.jsonl`);

    return c.json({ memories: memories.map(m => ({ ...m, project_id: projectId })) });
  } catch {
    return c.json({ memories: [] });
  }
});

// Get interactions for a project
beadsRoutes.get("/projects/:id/interactions", async (c) => {
  try {
    const projectId = c.req.param("id");
    const issueId = c.req.query("issue_id");
    const scanner = getScanner();
    const project = scanner.getProject(projectId);

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = new BeadsReader({} as any);
    let interactions = await reader.getInteractions(`${project.beadsPath}/interactions.jsonl`);
    interactions = interactions.map(i => ({ ...i, project_id: projectId }));

    if (issueId) {
      interactions = interactions.filter(i => i.issue_id === issueId);
    }

    return c.json({ interactions });
  } catch {
    return c.json({ interactions: [] });
  }
});

// Get aggregated stats
beadsRoutes.get("/projects/:id/stats", async (c) => {
  try {
    const projectId = c.req.param("id");
    const scanner = getScanner();
    const issues = await getIssues(scanner, projectId);

    const lastActivityAt = issues.reduce<string | null>((latest, issue) => {
      const candidate = issue.closed_at || issue.updated_at || issue.created_at;
      if (!candidate) return latest;
      return !latest || candidate > latest ? candidate : latest;
    }, null);

    return c.json({
      stats: {
        total: issues.filter(i => i.status !== "closed").length,
        open: issues.filter(i => i.status === "open").length,
        in_progress: issues.filter(i => i.status === "in_progress").length,
        blocked: issues.filter(i => i.status === "blocked").length,
        closed: issues.filter(i => i.status === "closed").length,
        last_activity_at: lastActivityAt,
        by_priority: {
          p0: issues.filter(i => i.priority === 0).length,
          p1: issues.filter(i => i.priority === 1).length,
          p2: issues.filter(i => i.priority === 2).length,
          p3: issues.filter(i => i.priority === 3).length,
          p4: issues.filter(i => i.priority === 4).length,
        },
        by_type: {
          bug: issues.filter(i => i.issue_type === "bug").length,
          feature: issues.filter(i => i.issue_type === "feature").length,
          task: issues.filter(i => i.issue_type === "task").length,
          epic: issues.filter(i => i.issue_type === "epic").length,
          chore: issues.filter(i => i.issue_type === "chore").length,
        },
      }
    });
  } catch (error) {
    console.error("[api] Error getting stats:", error);
    return c.json({ error: "Failed to get stats" }, 500);
  }
});

// Health check
beadsRoutes.get("/projects/:id/connection", async (c) => {
  try {
    const projectId = c.req.param("id");
    const scanner = getScanner();
    const project = scanner.getProject(projectId);

    if (!project) {
      return c.json({ status: "not_found", error: "Project not found" });
    }

    if (!project.doltPort) {
      return c.json({ status: "jsonl_fallback", note: "Reading from JSONL files" });
    }

    const client = getDoltClient(project.doltPort);
    await client.connect();

    return c.json({
      status: "connected",
      port: project.doltPort,
      database: project.doltDatabase || "dolt",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ status: "jsonl_fallback", note: "Dolt unavailable, reading from JSONL", error: message });
  }
});

/**
 * Get issues - try dolt first, fallback to JSONL
 */
async function getIssues(scanner: ProjectScanner, projectId: string): Promise<BeadIssue[]> {
  const project = scanner.getProject(projectId);

  if (!project) {
    console.log(`[api] Project ${projectId} not found`);
    return [];
  }

  const cacheKey = `issues:${projectId}`;
  const cached = readCache<BeadIssue[]>(cacheKey);
  if (cached) {
    void refreshIssues(project, cacheKey);
    return cached;
  }

  return await refreshIssues(project, cacheKey);
}

async function refreshIssues(project: BeadsProject, cacheKey: string): Promise<BeadIssue[]> {
  const issues = await readProjectIssues(project).catch(() => [] as BeadIssue[]);
  writeCache(cacheKey, issues);
  return issues;
}

async function readProjectIssues(project: BeadsProject): Promise<BeadIssue[]> {
  if (project.doltPort) {
    try {
      const client = getDoltClient(project.doltPort);
      return await client.getIssues({ limit: 1000 });
    } catch (error) {
      console.log(`[api] Dolt failed for ${project.id}, falling back to JSONL:`, error);
    }
  }

  return readIssuesFromJsonl(project.beadsPath);
}
