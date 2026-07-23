// Pure SQL query services for the Console graph read model (xtrm-native path).
// Owns issue + specialist projection joins against the durable
// `substrate_issues`, `substrate_dependencies`, and `specialist_jobs` tables,
// plus source-health derivation from `materialization_state`.
//
// The scanner-driven graph path (ProjectScanner + DoltClient + JSONL fallback)
// is owned by `apps/gitboard`'s source-lifecycle and is intentionally not
// re-implemented here. Callers decide which path to take and call
// `readXtrmGraphSnapshot` to materialize the joined payload.
//
// Opaque issue IDs, bead_ids, and chain_ids are preserved verbatim.

import type { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import { makeSourceHealth, type SourceHealth } from "../source-health.ts";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphFreshness,
  GraphNode,
  GraphNodeStatus,
  GraphNodeType,
  GraphResponse,
  GraphSpecialist,
  GraphSpecialistStatus,
} from "../../types/graph.ts";

export type {
  GraphEdge,
  GraphEdgeType,
  GraphFreshness,
  GraphNode,
  GraphNodeStatus,
  GraphNodeType,
  GraphResponse,
  GraphSpecialist,
  GraphSpecialistStatus,
  SpecialistStatus,
} from "../../types/graph.ts";

export interface GraphSnapshotResult {
  graph: GraphResponse;
  freshness: GraphFreshness;
  sourceHealth?: SourceHealth;
}

const NODE_TYPES = new Set<string>(["task", "bug", "feature", "epic", "chore", "decision", "molecule"]);
const LIVE_STATUSES = new Set<string>(["starting", "running", "waiting"]);
const ACTIVE_GRAPH_STATUSES = new Set<string>(["open", "in_progress", "in_review", "blocked", "deferred"]);

export interface XtrmGraphSource {
  sourceKey: string;
  projectId: string;
  path: string;
  projectName: string;
}

export function resolveXtrmGraphSource(db: Database, projectId: string | null | undefined): XtrmGraphSource | null {
  const normalizedProjectId = projectId?.trim();
  let row: { source_key: string; path: string } | undefined;
  if (normalizedProjectId) {
    row = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND source_key = ? LIMIT 1").get(`beads:${normalizedProjectId}`) as { source_key: string; path: string } | undefined;
    if (!row) {
      const candidates = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND status IN ('active', 'missing') ORDER BY source_key ASC").all() as Array<{ source_key: string; path: string }>;
      row = candidates.find((candidate) => {
        const sourceProjectId = candidate.source_key.replace(/^beads:/, "");
        return sourceProjectId === normalizedProjectId || projectNameFromBeadsPath(candidate.path) === normalizedProjectId;
      });
    }
  } else {
    row = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND status IN ('active', 'missing') ORDER BY source_key ASC LIMIT 1").get() as { source_key: string; path: string } | undefined;
  }
  if (!row) return null;
  return { sourceKey: row.source_key, projectId: row.source_key.replace(/^beads:/, ""), path: row.path, projectName: projectNameFromBeadsPath(row.path) };
}

export function readXtrmGraphSnapshot(db: Database, projectId: string | null | undefined, includeClosed: boolean): GraphSnapshotResult {
  const source = resolveXtrmGraphSource(db, projectId);
  if (!source) {
    const project = projectFallbackNote(projectId);
    return {
      graph: emptyGraph(projectId ?? "", project),
      freshness: "degraded",
      sourceHealth: makeSourceHealth("graph", "degraded", {
        message: projectId ? `Graph project "${projectId}" was not found.` : "Graph project_id is missing; select a beads project.",
        metadata: { project },
      }),
    };
  }
  const issues = readXtrmGraphIssues(db, source.projectId, includeClosed);
  const specialists = readXtrmGraphSpecialists(db, source.projectId);
  const graph = buildGraph(source, issues, specialists, includeClosed);
  const state = readXtrmMaterializationState(db, source.sourceKey);
  const health = graphHealthFromMaterialization(state);
  return { graph, freshness: health.freshness, sourceHealth: health.sourceHealth };
}

function readXtrmGraphIssues(db: Database, projectId: string, includeClosed: boolean): GraphIssue[] {
  const rows = db.query(`
    SELECT issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at
    FROM substrate_issues
    WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')
    ORDER BY priority ASC, created_at DESC, issue_id ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  const dependencyTargets = db.query(`
    SELECT issue_id, title, state, issue_type
    FROM substrate_issues
    WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')
  `).all(projectId) as Array<Record<string, unknown>>;
  const dependencyTargetIndex = new Map(dependencyTargets.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = new Map<string, GraphDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    const target = dependencyTargetIndex.get(dep.dep_issue_id);
    list.push({
      id: dep.dep_issue_id,
      title: target == null ? "" : String(target.title ?? ""),
      status: target == null ? "open" : normalizeTextValue(target.state, "open"),
      issue_type: target == null ? undefined : String(target.issue_type ?? "task"),
      dependency_type: dep.relation,
    });
    depsByIssue.set(dep.issue_id, list);
  }

  return rows.map((row) => ({
    id: String(row.issue_id),
    title: String(row.title ?? ""),
    description: row.body == null ? null : String(row.body),
    notes: row.notes == null ? null : String(row.notes),
    status: normalizeTextValue(row.state, "open"),
    priority: Number(row.priority ?? 2),
    issue_type: String(row.issue_type ?? "task"),
    owner: row.owner == null ? null : String(row.owner),
    created_at: String(row.created_at ?? new Date(0).toISOString()),
    created_by: null,
    updated_at: String(row.updated_at ?? new Date(0).toISOString()),
    closed_at: row.closed_at == null ? (row.deleted_at == null ? null : String(row.deleted_at)) : String(row.closed_at),
    close_reason: row.close_reason == null ? undefined : String(row.close_reason),
    project_id: projectId,
    dependencies: depsByIssue.get(String(row.issue_id)) ?? [],
    parent_id: row.parent_id == null ? undefined : String(row.parent_id),
    related_ids: parseJsonStringArray(row.related_ids),
    labels: parseJsonStringArray(row.labels),
  })).filter((issue) => includeClosed || normalizeStatus(issue.status) !== "closed");
}

function readXtrmGraphSpecialists(db: Database, projectId: string): GraphSpecialistJob[] {
  const rows = db.query(`
    SELECT repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist, last_output
    FROM specialist_jobs
    WHERE repo_slug = ? AND status IN ('starting', 'running', 'waiting')
    ORDER BY COALESCE(updated_at, '') DESC, job_id ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repo_slug),
    beadId: String(row.bead_id ?? row.job_id),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status),
    updatedAt: String(row.updated_at ?? new Date(0).toISOString()),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
  }));
}

function readXtrmMaterializationState(db: Database, sourceKey: string): { last_success_at: string | null; last_status: string | null; last_error: string | null } | null {
  return db.query("SELECT last_success_at, last_status, last_error FROM materialization_state WHERE source_key = ?").get(sourceKey) as { last_success_at: string | null; last_status: string | null; last_error: string | null } | null;
}

function graphHealthFromMaterialization(state: ReturnType<typeof readXtrmMaterializationState>): { freshness: GraphFreshness; sourceHealth: SourceHealth } {
  const ageSeconds = state?.last_success_at ? Math.max(0, Math.floor((Date.now() - Date.parse(state.last_success_at)) / 1000)) : null;
  const metadata = { last_status: state?.last_status ?? null, last_success_at: state?.last_success_at ?? null, age_seconds: ageSeconds };
  if (!state?.last_success_at) return { freshness: "stale", sourceHealth: makeSourceHealth("graph", "degraded", { metadata }) };
  if (state.last_status === "error") return { freshness: "fresh", sourceHealth: makeSourceHealth("graph", "degraded", { message: "Graph source materialization failed.", metadata }) };
  if (state.last_status === "success") return { freshness: "fresh", sourceHealth: makeSourceHealth("graph", "fresh", { metadata }) };
  return { freshness: "stale", sourceHealth: makeSourceHealth("graph", "stale", { metadata }) };
}

function buildGraph(source: XtrmGraphSource, issues: GraphIssue[], specialists: GraphSpecialistJob[], includeClosed: boolean): GraphResponse {
  const issueMap = new Map(issues.map((issue) => [issue.id, issue]));
  const allEdges = issues.flatMap((issue) => issue.dependencies.map((dependency) => normalizeEdge(issue.id, dependency)).filter((edge): edge is GraphEdge => edge !== null));
  const supersededTargets = new Set(allEdges.filter((edge) => edge.type === "supersedes").map((edge) => edge.to));
  const ghostNodes = new Map<string, GraphNode>();
  for (const issue of issues) {
    for (const dependency of issue.dependencies) {
      if (issueMap.has(dependency.id) || ghostNodes.has(dependency.id)) continue;
      ghostNodes.set(dependency.id, {
        id: dependency.id,
        title: dependency.title?.trim() || dependency.id,
        type: normalizeNodeType(dependency.issue_type ?? "task"),
        priority: 2,
        status: normalizeStatus(dependency.status),
        assignee: null,
        closed_at: null,
        superseded_by: null,
      });
    }
  }

  const visibleIds = new Set<string>();
  for (const issue of issues) {
    if (includeClosed || issue.status !== "closed") visibleIds.add(issue.id);
  }
  for (const id of supersededTargets) {
    const issue = issueMap.get(id);
    const ghost = ghostNodes.get(id);
    const status = issue?.status ?? ghost?.status;
    if (includeClosed || status !== "closed") visibleIds.add(id);
  }
  for (const [id, ghost] of ghostNodes) {
    if (includeClosed || ghost.status !== "closed") visibleIds.add(id);
  }

  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const nodes = [...visibleIds].map((id) => {
    const issue = issueMap.get(id);
    if (issue) {
      return {
        id: issue.id,
        title: issue.title,
        type: normalizeNodeType(issue.issue_type),
        priority: clampPriority(issue.priority),
        status: normalizeStatus(issue.status),
        assignee: issue.owner,
        closed_at: issue.closed_at ?? null,
        superseded_by: null,
      };
    }
    return ghostNodes.get(id) ?? null;
  }).filter((node): node is GraphNode => node !== null);
  const supersededBy = new Map(edges.filter((edge) => edge.type === "supersedes").map((edge) => [edge.to, edge.from]));
  const specialistsOverlay = specialists.filter((job) => LIVE_STATUSES.has(job.status)).map(toGraphSpecialist);

  return {
    project_id: source.projectId,
    repo_slug: source.projectId,
    generated_at: new Date().toISOString(),
    nodes: nodes.map((node) => ({ ...node, superseded_by: supersededBy.get(node.id) ?? null })),
    edges,
    specialists: specialistsOverlay,
  };
}

function toGraphSpecialist(job: GraphSpecialistJob): GraphSpecialist {
  return {
    bead_id: job.beadId,
    job_id: job.jobId ?? job.beadId,
    role: job.chainKind ?? job.specialist ?? "executor",
    status: normalizeSpecialistStatus(job.status),
    updated_at: job.updatedAt,
  };
}

function normalizeSpecialistStatus(status: string): GraphSpecialistStatus {
  if (status === "starting" || status === "running" || status === "waiting" || status === "done" || status === "error" || status === "cancelled") return status;
  return "waiting";
}

function normalizeEdge(fromId: string, dependency: GraphDependency): GraphEdge | null {
  switch (dependency.dependency_type) {
    case "blocks":
    case "tracks":
    case "related":
    case "parent-child":
    case "discovered-from":
    case "validates":
    case "caused-by":
    case "until":
    case "supersedes":
      return { from: fromId, to: dependency.id, type: dependency.dependency_type as GraphEdgeType };
    case "blocked_by":
      return { from: dependency.id, to: fromId, type: "blocks" };
    case "parent":
      return { from: dependency.id, to: fromId, type: "parent-child" };
    case "relates-to":
      return { from: fromId, to: dependency.id, type: "related" };
    default:
      return null;
  }
}

function normalizeNodeType(type: string): GraphNodeType {
  return NODE_TYPES.has(type) ? (type as GraphNodeType) : "task";
}

function normalizeStatus(status: string): GraphNodeStatus {
  const normalized = normalizeTextValue(status, "open");
  if (normalized === "open" || normalized === "in_progress" || normalized === "blocked" || normalized === "closed" || normalized === "deferred") return normalized;
  if (normalized === "in_review") return "in_progress";
  return "open";
}

function clampPriority(value: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= 1) return 1;
  if (value <= 2) return 2;
  if (value <= 3) return 3;
  return 4;
}

function emptyGraph(projectId: string, project?: string): GraphResponse {
  return { project_id: projectId, repo_slug: projectId, generated_at: new Date().toISOString(), nodes: [], edges: [], specialists: [], ...(project ? { project } : {}) };
}

function projectFallbackNote(projectId: string | null | undefined): string {
  return projectId ? `missing-project:${projectId}` : "fallback:no-selected-repo";
}

function parseJsonStringArray(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeTextValue(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed == null ? fallback : String(parsed);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

interface GraphDependency {
  id: string;
  title: string;
  status: string;
  issue_type?: string;
  dependency_type: string;
}

interface GraphIssue {
  id: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: string;
  priority: number;
  issue_type: string;
  owner: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  closed_at: string | null;
  close_reason?: string;
  project_id: string;
  dependencies: GraphDependency[];
  parent_id?: string;
  related_ids: string[];
  labels: string[];
}

interface GraphSpecialistJob {
  jobId: string | null;
  repoSlug: string;
  beadId: string;
  chainId: string | null;
  epicId: string | null;
  chainKind: string | null;
  status: string;
  updatedAt: string;
  specialist: string | null;
  lastOutput: string | null;
}

function projectNameFromBeadsPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return basename(normalized) === ".beads" ? basename(dirname(normalized)) : basename(normalized);
}

// Silence unused-export warning for ACTIVE_GRAPH_STATUSES — kept for parity
// with the prior gitboard graph DAO behavior (closed inclusion is an explicit
// option, not a global filter).
void ACTIVE_GRAPH_STATUSES;
