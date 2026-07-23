import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { formatSourceDisplayPath } from "../../../../../packages/core/src/runtime/source-lifecycle-policy.ts";
import { BeadsReader } from "../../../../../packages/core/src/state/beads-reader.ts";
import { readBeadsSourceFacts, readSubstrateProjectConnection, readSubstrateProjectRepairActions } from "../../../../../packages/core/src/state/substrate-project-service.ts";
import type { BeadDependency, BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../../../../../packages/core/src/types/beads.ts";
import {
  countSubstrateIssues as coreCountSubstrateIssues,
  getBeadsSourcePath as coreGetBeadsSourcePath,
  readSourceMaterializationState as coreReadSourceMaterializationState,
  readSubstrateClosedIssues as coreReadSubstrateClosedIssues,
  readSubstrateIssueDependents as coreReadSubstrateIssueDependents,
  readSubstrateIssueDetail as coreReadSubstrateIssueDetail,
  readSubstrateIssues as coreReadSubstrateIssues,
  readSubstrateRuntimeGraph as coreReadSubstrateRuntimeGraph,
  readSubstrateStats as coreReadSubstrateStats,
  type SubstrateDependency,
  type SubstrateIssue,
  type SubstrateIssueFilters,
} from "../../../../../packages/core/src/state/index.ts";
export type SubstrateRouterOptions = {
  emit?: (entry: LogEntry) => void;
};

export function createSubstrateRouter(xtrmDb?: Database | null, options: SubstrateRouterOptions = {}): Hono {
  const router = new Hono();
  const loggedProjectMemories = new Set<string>();
  const loggedProjectInteractions = new Set<string>();

  router.get("/projects", (c) => c.json({ projects: readProjects(xtrmDb) }));
  router.get("/projects/:projectId/issues", (c) => c.json({ issues: readIssues(xtrmDb, c.req.param("projectId"), parseIssueFilters(c)) }));
  router.get("/projects/:projectId/issues/closed", (c) => c.json({ issues: readClosedIssues(xtrmDb, c.req.param("projectId"), parseLimit(c.req.query("limit"), 50) ?? 50) }));
  router.get("/projects/:projectId/issues/:issueId", (c) => {
    const issue = readIssueDetail(xtrmDb, c.req.param("projectId"), c.req.param("issueId"));
    return issue ? c.json({ issue }) : c.json({ error: "Issue not found" }, 404);
  });
  router.get("/projects/:projectId/memories", async (c) => c.json({ memories: await readMemories(xtrmDb, c.req.param("projectId"), loggedProjectMemories, options.emit) }));
  router.get("/projects/:projectId/interactions", async (c) => c.json({ interactions: await readInteractions(xtrmDb, c.req.param("projectId"), loggedProjectInteractions, options.emit, c.req.query("issue_id") ?? undefined) }));
  router.get("/projects/:projectId/runtime-graph", (c) => c.json(readRuntimeGraph(xtrmDb, c.req.param("projectId"))));
  router.get("/projects/:projectId/stats", (c) => c.json({ stats: readStats(xtrmDb, c.req.param("projectId")) }));
  router.get("/projects/:projectId/connection", async (c) => c.json(await readSubstrateProjectConnection(xtrmDb, c.req.param("projectId"))));
  router.get("/projects/:projectId/repair-actions", async (c) => c.json(await readSubstrateProjectRepairActions(xtrmDb, c.req.param("projectId"))));

  return router;
}

function readProjects(db?: Database | null): BeadsProject[] {
  if (!db) return [];
  const rows = db.query("SELECT source_key, path, last_seen_at FROM sources WHERE kind = 'beads' ORDER BY source_key ASC").all() as Array<{ source_key: string; path: string; last_seen_at: string | null }>;
  return rows.map((row) => {
    const id = row.source_key.replace(/^beads:/, "");
    const facts = readBeadsSourceFacts(row.path);
    const state = coreReadSourceMaterializationState(db, row.source_key);
    const healthState = state?.last_status === "error" ? "degraded" : facts.doltPort ? "fresh" : "stale";
    return {
      id,
      name: facts.projectName,
      path: formatSourceDisplayPath(facts.repoPath),
      beadsPath: formatSourceDisplayPath(row.path),
      doltPort: facts.doltPort,
      doltDatabase: facts.doltDatabase,
      source: facts.doltPort ? "dolt" : "jsonl",
      sourcePriority: facts.doltPort ? ["dolt", "jsonl"] : ["jsonl"],
      status: facts.doltPort ? "active" : "idle",
      lastScanned: row.last_seen_at ?? facts.jsonlUpdatedAt ?? new Date(0).toISOString(),
      issueCount: coreCountSubstrateIssues(db, id),
      sourceHealth: [{ kind: facts.doltPort ? "dolt" : "jsonl", state: healthState, detail: state?.last_error ?? undefined }],
    } satisfies BeadsProject;
  });
}

function readIssues(db: Database | null | undefined, projectId: string, filters: SubstrateIssueFilters): BeadIssue[] {
  const issues = coreReadSubstrateIssues(db, projectId, filters);
  return issues.map(toBeadIssue);
}

function readClosedIssues(db: Database | null | undefined, projectId: string, limit: number): BeadIssue[] {
  return coreReadSubstrateClosedIssues(db, projectId, limit).map(toBeadIssue);
}

function readIssueDetail(db: Database | null | undefined, projectId: string, issueId: string): BeadIssueDetail | null {
  const issue = coreReadSubstrateIssueDetail(db, projectId, issueId);
  if (!issue) return null;
  const dependents = coreReadSubstrateIssueDependents(db, projectId, issueId).map(toBeadDependency);
  const baseIssue = toBeadIssue(issue);
  return { ...baseIssue, dependents, children: dependents.filter((dep) => dep.dependency_type === "parent-child"), source: "unknown", sourceHealth: [{ kind: "unknown", state: "fresh" }] };
}

async function readMemories(
  db: Database | null | undefined,
  projectId: string,
  seen: Set<string>,
  emit?: (entry: LogEntry) => void,
): Promise<Memory[]> {
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  if (!beadsPath) return [];
  const memories = await new BeadsReader(db as Database).getMemories(`${beadsPath}/knowledge.jsonl`);
  if (memories.length === 0) {
    logEmptyOrMissingProjectData(seen, emit, "substrate.readMemories", projectId, beadsPath);
  } else {
    logProjectDataOnce(seen, emit, "substrate.readMemories", projectId, beadsPath, memories.length);
  }
  return memories;
}

async function readInteractions(
  db: Database | null | undefined,
  projectId: string,
  seen: Set<string>,
  emit?: (entry: LogEntry) => void,
  issueId?: string,
): Promise<Interaction[]> {
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  if (!beadsPath) return [];
  const interactions = await new BeadsReader(db as Database).getInteractions(`${beadsPath}/interactions.jsonl`);
  const filtered = issueId ? interactions.filter((interaction) => interaction.issue_id === issueId) : interactions;
  if (filtered.length === 0) {
    logEmptyOrMissingProjectData(seen, emit, "substrate.readInteractions", projectId, beadsPath);
  } else {
    logProjectDataOnce(seen, emit, "substrate.readInteractions", projectId, beadsPath, filtered.length);
  }
  return filtered;
}
function readStats(db: Database | null | undefined, projectId: string) {
  return coreReadSubstrateStats(db, projectId);
}

function readRuntimeGraph(db: Database | null | undefined, projectId: string) {
  return coreReadSubstrateRuntimeGraph(db, projectId);
}

function toBeadIssue(issue: SubstrateIssue): BeadIssue {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    notes: issue.notes,
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner,
    created_at: issue.created_at,
    created_by: issue.created_by,
    updated_at: issue.updated_at,
    ...(issue.closed_at !== undefined ? { closed_at: issue.closed_at } : {}),
    ...(issue.close_reason !== undefined ? { close_reason: issue.close_reason } : {}),
    project_id: issue.project_id,
    dependencies: issue.dependencies.map(toBeadDependency),
    ...(issue.parent_id !== undefined ? { parent_id: issue.parent_id } : {}),
    related_ids: issue.related_ids,
    labels: issue.labels,
  };
}

function toBeadDependency(dep: SubstrateDependency): BeadDependency {
  return {
    id: dep.id,
    title: dep.title,
    status: dep.status,
    issue_type: dep.issue_type,
    dependency_type: dep.dependency_type as BeadDependency["dependency_type"],
  };
}

function logEmptyOrMissingProjectData(seen: Set<string>, emit: ((entry: LogEntry) => void) | undefined, event: string, projectId: string, beadsPath: string): void {
  const key = `${projectId}:${beadsPath}:empty-or-missing`;
  if (seen.has(key)) return;
  seen.add(key);
  emit?.(makeLogEntry("api", event, "debug", undefined, { projectId, path: formatSourceDisplayPath(beadsPath), status: "empty-or-missing" }));
}

function logProjectDataOnce(seen: Set<string>, emit: ((entry: LogEntry) => void) | undefined, event: string, projectId: string, beadsPath: string, count: number): void {
  const key = `${projectId}:${beadsPath}`;
  if (seen.has(key)) return;
  seen.add(key);
  emit?.(makeLogEntry("api", event, "info", undefined, { projectId, path: formatSourceDisplayPath(beadsPath), count }));
}

function parseIssueFilters(c: { req: { query(name: string): string | undefined } }): SubstrateIssueFilters {
  return {
    status: c.req.query("status")?.split(","),
    priority: c.req.query("priority")?.split(",").map(Number),
    issue_type: c.req.query("issue_type")?.split(","),
    search: c.req.query("search") ?? undefined,
    limit: parseLimit(c.req.query("limit")),
  };
}

function parseLimit(value: string | undefined, fallback?: number): number | undefined {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
