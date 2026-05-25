import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { BeadDependency, BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../../../../beadboard/src/types/beads.ts";

export function createSubstrateRouter(xtrmDb?: Database | null): Hono {
  const router = new Hono();

  router.get("/projects", (c) => c.json({ projects: readProjects(xtrmDb) }));
  router.get("/projects/:projectId/issues", (c) => c.json({ issues: readIssues(xtrmDb, c.req.param("projectId"), parseIssueFilters(c)) }));
  router.get("/projects/:projectId/issues/closed", (c) => c.json({ issues: readClosedIssues(xtrmDb, c.req.param("projectId"), parseLimit(c.req.query("limit"), 50)) }));
  router.get("/projects/:projectId/issues/:issueId", (c) => {
    const issue = readIssueDetail(xtrmDb, c.req.param("projectId"), c.req.param("issueId"));
    return issue ? c.json({ issue }) : c.json({ error: "Issue not found" }, 404);
  });
  router.get("/projects/:projectId/memories", (c) => c.json({ memories: readMemories(xtrmDb, c.req.param("projectId")) }));
  router.get("/projects/:projectId/interactions", (c) => c.json({ interactions: readInteractions(xtrmDb, c.req.param("projectId"), c.req.query("issue_id") ?? undefined) }));
  router.get("/projects/:projectId/stats", (c) => c.json({ stats: readStats(xtrmDb, c.req.param("projectId")) }));
  router.get("/projects/:projectId/connection", (c) => c.json(readConnection(xtrmDb, c.req.param("projectId"))));

  return router;
}

function readProjects(db?: Database | null): BeadsProject[] {
  if (!db) return [];
  const rows = db.query("SELECT source_key, path, last_seen_at FROM sources WHERE kind = 'beads' ORDER BY source_key ASC").all() as Array<{ source_key: string; path: string; last_seen_at: string | null }>;
  return rows.map((row) => ({
    id: row.source_key.replace(/^beads:/, ""),
    name: row.path.split("/").filter(Boolean).at(-2) ?? row.source_key,
    path: row.path,
    beadsPath: row.path,
    source: "unknown",
    status: "active",
    lastScanned: row.last_seen_at ?? new Date(0).toISOString(),
    issueCount: countIssues(db, row.source_key.replace(/^beads:/, "")),
    sourceHealth: [{ kind: "unknown", state: "available" }],
  }));
}

function readIssues(db: Database | null | undefined, projectId: string, filters: { status?: string[]; priority?: number[]; search?: string; limit?: number }): BeadIssue[] {
  const issues = queryIssues(db, projectId);
  return applyIssueFilters(issues, filters);
}

function readClosedIssues(db: Database | null | undefined, projectId: string, limit: number): BeadIssue[] {
  return queryIssues(db, projectId).filter((issue) => issue.status === "closed").slice(0, limit);
}

function readIssueDetail(db: Database | null | undefined, projectId: string, issueId: string): BeadIssueDetail | null {
  const issue = queryIssues(db, projectId).find((row) => row.id === issueId);
  if (!issue) return null;
  const dependents = queryDependents(db, projectId, issueId);
  return { ...issue, dependents, children: dependents.filter((dep) => dep.dependency_type === "parent-child"), source: "unknown", sourceHealth: [{ kind: "unknown", state: "available" }] };
}

function readMemories(_db: Database | null | undefined, _projectId: string): Memory[] { return []; }
function readInteractions(_db: Database | null | undefined, _projectId: string, _issueId?: string): Interaction[] { return []; }
function readStats(db: Database | null | undefined, projectId: string) {
  const issues = queryIssues(db, projectId);
  type Stats = { total: number; open: number; in_progress: number; blocked: number; closed: number; by_priority: Record<string, number>; by_type: Record<string, number> };
  return issues.reduce<Stats>((acc, issue) => {
    acc.total += 1;
    if (issue.status in acc) acc[issue.status as keyof Omit<Stats, "by_priority" | "by_type">] += 1;
    return acc;
  }, { total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0, by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }, by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 } });
}

function readConnection(_db: Database | null | undefined, _projectId: string) { return { source: "sqlite", status: "substrate_connected", degraded: false, message: "xtrm.sqlite connected" }; }

function queryIssues(db: Database | null | undefined, projectId: string): BeadIssue[] {
  if (!db) return [];
  const rows = db.query("SELECT issue_id, title, body, state, deleted_at, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(projectId) as Array<Record<string, unknown>>;
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = new Map<string, BeadDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    list.push({ id: dep.dep_issue_id, title: "", status: "open", dependency_type: dep.relation });
    depsByIssue.set(dep.issue_id, list);
  }
  return rows.map((row) => ({
    id: String(row.issue_id),
    title: String(row.title ?? ""),
    description: row.body == null ? null : String(row.body),
    notes: null,
    status: String(row.state ?? "open"),
    priority: 2,
    issue_type: "task",
    owner: null,
    created_at: String(row.created_at ?? new Date(0).toISOString()),
    created_by: null,
    updated_at: String(row.updated_at ?? new Date(0).toISOString()),
    closed_at: row.deleted_at == null ? undefined : String(row.deleted_at),
    project_id: projectId,
    dependencies: depsByIssue.get(String(row.issue_id)) ?? [],
    related_ids: [],
    labels: [],
  }));
}

function queryDependents(db: Database | null | undefined, projectId: string, issueId: string): BeadDependency[] {
  if (!db) return [];
  const rows = db.query("SELECT issue_id, relation FROM substrate_dependencies WHERE repo_slug = ? AND dep_issue_id = ? ORDER BY issue_id ASC").all(projectId, issueId) as Array<{ issue_id: string; relation: string }>;
  return rows.map((row) => ({ id: row.issue_id, title: "", status: "open", dependency_type: row.relation }));
}

function countIssues(db: Database, projectId: string): number {
  return Number((db.query("SELECT COUNT(*) AS count FROM substrate_issues WHERE repo_slug = ?").get(projectId) as { count: number } | undefined)?.count ?? 0);
}

function applyIssueFilters(issues: BeadIssue[], filters: { status?: string[]; priority?: number[]; search?: string; limit?: number }): BeadIssue[] {
  let filtered = issues;
  if (filters.status?.length) filtered = filtered.filter((issue) => filters.status?.includes(issue.status));
  if (filters.priority?.length) filtered = filtered.filter((issue) => filters.priority?.includes(issue.priority));
  if (filters.search) {
    const search = filters.search.toLowerCase();
    filtered = filtered.filter((issue) => issue.title.toLowerCase().includes(search) || issue.description?.toLowerCase().includes(search) || issue.notes?.toLowerCase().includes(search));
  }
  return filtered.slice(0, filters.limit ?? 100);
}

function parseIssueFilters(c: { req: { query(name: string): string | undefined } }) {
  return {
    status: c.req.query("status")?.split(","),
    priority: c.req.query("priority")?.split(",").map(Number),
    search: c.req.query("search") ?? undefined,
    limit: parseLimit(c.req.query("limit"), 100),
  };
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
