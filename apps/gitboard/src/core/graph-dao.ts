import type { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import { createAttachPool } from "../server/observability/attach-pool.ts";
import { emit, makeLogEntry } from "./logger.ts";
import { createObservabilityDao } from "../server/observability/dao.ts";
import { listRepos } from "../server/observability/registry.ts";
import { readIssuesFromJsonl } from "./jsonl-reader.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { DoltClient } from "./dolt-client.ts";
import type { BeadDependency, BeadIssue, BeadsProject } from "../types/beads.ts";
import type { GraphEdge, GraphEdgeType, GraphNode, GraphNodeStatus, GraphNodeType, GraphResponse, GraphSpecialist } from "../types/graph.ts";
import { makeSourceHealth, type SourceHealth } from "../types/source-health.ts";
import type { SpecialistJob } from "../server/observability/types.ts";

const NODE_TYPES = new Set(["task", "bug", "feature", "epic", "chore", "decision", "molecule"]);
const LIVE_STATUSES = new Set(["starting", "running", "waiting"]);

let scannerInstance: ProjectScanner | null = null;
let observabilityDao: ReturnType<typeof createObservabilityDao> | null = null;
let observabilityWarm: Promise<void> | null = null;

const PROJECT_REFRESH_MS = 30_000;
const ISSUE_REFRESH_MS = 10_000;
const GRAPH_WARM_TIMEOUT_MS = 750;
const GRAPH_SNAPSHOT_CACHE_MS = 10_000;

interface CacheEntry<T> {
  value: T;
  refreshAt: number;
}

const projectScanCache = new WeakMap<ProjectScanner, CacheEntry<{ key: string; projects: BeadsProject[] }>>();
const projectScanInflight = new WeakMap<ProjectScanner, Promise<BeadsProject[]>>();
const issueCache = new Map<string, CacheEntry<{ key: string; issues: BeadIssue[]; freshness: "fresh" | "stale" | "degraded" }>>();
const issueInflight = new Map<string, Promise<void>>();
const graphSnapshotCache = new Map<string, CacheEntry<{ graph: GraphResponse; freshness: "fresh" | "stale" | "degraded" }>>();
const projectIssueEpochs = new Map<string, number>();
let globalIssueEpoch = 0;

export interface GraphDaoOptions {
  scanner?: ProjectScanner;
  observability?: ReturnType<typeof createObservabilityDao>;
  xtrmDb?: Database | null;
  triggerMaterialization?: (projectId?: string | null) => void;
}

type GraphSnapshotResult = { graph: GraphResponse; freshness: "fresh" | "stale" | "degraded"; sourceHealth?: SourceHealth };

export function createGraphDao(options: GraphDaoOptions = {}) {
  if (options.xtrmDb) {
    const xtrmDb = options.xtrmDb;
    return {
      requiresProtectedRefresh: true,
      getGraphSnapshot(projectId: string | null | undefined, includeClosed = false): GraphSnapshotResult {
        return readXtrmGraphSnapshot(xtrmDb, projectId, includeClosed);
      },
      async getGraphSnapshotWarm(projectId: string | null | undefined, includeClosed = false): Promise<GraphSnapshotResult> {
        return readXtrmGraphSnapshot(xtrmDb, projectId, includeClosed);
      },
      invalidate(projectId?: string | null): void {
        options.triggerMaterialization?.(projectId);
      },
    };
  }

  const scanner = options.scanner ?? getScanner();
  const getDao = () => options.observability ?? getObservabilityDao();

  return {
    requiresProtectedRefresh: false,
    getGraphSnapshot(projectId: string | null | undefined, includeClosed = false): GraphSnapshotResult {
      return readGraphSnapshot(scanner, getDao, projectId, includeClosed);
    },
    async getGraphSnapshotWarm(projectId: string | null | undefined, includeClosed = false): Promise<GraphSnapshotResult> {
      if (hasCachedGraphSnapshot(scanner, projectId, includeClosed)) return readGraphSnapshot(scanner, getDao, projectId, includeClosed);

      const startedAt = performance.now();
      void getObservabilityDao();
      const cachedScan = readCachedProjects(scanner);
      const projects = cachedScan?.projects ?? await withTimeout(scanProjects(scanner), GRAPH_WARM_TIMEOUT_MS);
      if (!projects) return readGraphSnapshot(scanner, getDao, projectId, includeClosed, startedAt);

      const project = resolveProject(projects, projectId);
      if (!project) return { graph: emptyGraph(projectId ?? "", projectFallbackNote(projectId, projects)), freshness: "degraded" };

      const remainingMs = Math.max(0, GRAPH_WARM_TIMEOUT_MS - (performance.now() - startedAt));
      await withTimeout(refreshIssues(project, includeClosed), remainingMs);
      return readGraphSnapshot(scanner, getDao, projectId, includeClosed, startedAt);
    },
    invalidate(projectId?: string | null): void {
      if (!projectId) {
        projectScanCache.delete(scanner);
        projectScanInflight.delete(scanner);
      }
      invalidateGraphCache(resolveProject(readCachedProjects(scanner)?.projects ?? [], projectId)?.id ?? projectId);
    },
  };
}

function readXtrmGraphSnapshot(db: Database, projectId: string | null | undefined, includeClosed: boolean): GraphSnapshotResult {
  const startedAt = performance.now();
  const source = resolveXtrmSource(db, projectId);
  if (!source) {
    const graph = emptyGraph(projectId ?? "", projectFallbackNote(projectId, []));
    const sourceHealth = makeSourceHealth("graph", "degraded", {
      message: projectId ? `Graph project "${projectId}" was not found.` : "Graph project_id is missing; select a beads project.",
      metadata: { project: graph.project },
    });
    return { graph, freshness: "degraded", sourceHealth };
  }

  const issues = readXtrmIssues(db, source.projectId, includeClosed);
  const specialists = readXtrmSpecialists(db, source.projectId);
  const graph = buildGraph({
    id: source.projectId,
    name: source.projectId,
    path: source.path,
    beadsPath: source.path,
    status: "active",
    lastScanned: stateTimestampFallback(),
    issueCount: issues.length,
  }, issues, specialists, includeClosed);
  const state = readXtrmMaterializationState(db, source.sourceKey);
  const health = graphHealthFromMaterialization(state);
  emit(makeLogEntry("api", "graph.xtrm_snapshot.timing", "info", undefined, {
    projectId: source.projectId,
    includeClosed,
    rows: issues.length,
    specialists: specialists.length,
    sourceHealth: health.sourceHealth.status,
    freshness: health.freshness,
    ms: Math.round(performance.now() - startedAt),
  }));
  return { graph, freshness: health.freshness, sourceHealth: health.sourceHealth };
}

function hasCachedGraphSnapshot(scanner: ProjectScanner, projectId: string | null | undefined, includeClosed: boolean): boolean {
  const cached = projectScanCache.get(scanner);
  if (!cached) return false;

  const project = resolveProject(cached.value.projects, projectId);
  if (!project) return true;
  const issues = issueCache.get(issueCacheKey(project, includeClosed));
  if (!issues) return false;

  // If the only cached graph source is expired empty data, don't short-circuit
  // warm loading. That stale-empty path is exactly what produces the misleading
  // "No beads" state during tab switches after a failed Dolt/JSONL read.
  return !(issues.refreshAt <= Date.now() && issues.value.issues.length === 0);
}

function readGraphSnapshot(
  scanner: ProjectScanner,
  getDao: () => ReturnType<typeof createObservabilityDao> | null,
  projectId: string | null | undefined,
  includeClosed: boolean,
  startedAt = performance.now(),
): { graph: GraphResponse; freshness: "fresh" | "stale" | "degraded" } {
  void warmGraphState(scanner);
  const scan = readCachedProjects(scanner);
  if (!scan) return { graph: emptyGraph(projectId ?? "", projectFallbackNote(projectId, [])), freshness: "stale" };

  const project = resolveProject(scan.projects, projectId);
  if (!project) return { graph: emptyGraph(projectId ?? "", projectFallbackNote(projectId, scan.projects)), freshness: "degraded" };

  const issueState = readCachedIssues(project, includeClosed);
  const snapshotKey = graphSnapshotCacheKey(project, includeClosed, issueState.key);
  const cachedSnapshot = readCachedGraphSnapshot(snapshotKey);
  if (cachedSnapshot) {
    emit(makeLogEntry("api", "graph.snapshot_cache", "info", undefined, { projectId: project.id, includeClosed, hit: true }));
    return cachedSnapshot;
  }

  const dao = getDao();
  const specialists = dao ? dao.inFlightJobs().filter((job) => job.repoSlug === project.id || job.repoSlug === project.name) : [];
  const graph = buildGraph(project, issueState.issues, specialists, includeClosed);
  const snapshot = { graph, freshness: issueState.freshness };
  if (issueState.freshness === "fresh") writeGraphSnapshot(snapshotKey, snapshot);
  emit(makeLogEntry("api", "graph.snapshot.timing", "info", undefined, { projectId: project.id, freshness: issueState.freshness, ms: Math.round(performance.now() - startedAt) }));
  return snapshot;
}

export function invalidateGraphCache(projectId?: string | null): void {
  if (!projectId) {
    globalIssueEpoch += 1;
    issueCache.clear();
    issueInflight.clear();
    graphSnapshotCache.clear();
    projectScanCache.delete(getScanner());
    projectScanInflight.delete(getScanner());
    return;
  }

  projectIssueEpochs.set(projectId, (projectIssueEpochs.get(projectId) ?? 0) + 1);
  for (const key of issueCache.keys()) {
    if (key.startsWith(`${projectId}:`)) issueCache.delete(key);
  }
  for (const key of issueInflight.keys()) {
    if (key.startsWith(`${projectId}:`)) issueInflight.delete(key);
  }
  for (const key of graphSnapshotCache.keys()) {
    if (key.startsWith(`${projectId}:`)) graphSnapshotCache.delete(key);
  }
}

function graphSnapshotCacheKey(project: BeadsProject, includeClosed: boolean, issueKey: string): string {
  return `${project.id}:${includeClosed ? "all" : "open"}:${issueKey}`;
}

function readCachedGraphSnapshot(key: string): { graph: GraphResponse; freshness: "fresh" | "stale" | "degraded" } | null {
  const cached = graphSnapshotCache.get(key);
  if (!cached) return null;
  if (cached.refreshAt <= Date.now()) {
    graphSnapshotCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeGraphSnapshot(key: string, value: { graph: GraphResponse; freshness: "fresh" | "stale" | "degraded" }): void {
  graphSnapshotCache.set(key, { value, refreshAt: Date.now() + GRAPH_SNAPSHOT_CACHE_MS });
  while (graphSnapshotCache.size > 100) {
    const oldest = graphSnapshotCache.keys().next().value;
    if (oldest === undefined) return;
    graphSnapshotCache.delete(oldest);
  }
}

async function warmGraphState(scanner: ProjectScanner): Promise<void> {
  const cached = projectScanCache.get(scanner);
  if (!cached || cached.refreshAt <= Date.now()) void scanProjects(scanner);
  void getObservabilityDao();
}

async function scanProjects(scanner: ProjectScanner): Promise<BeadsProject[]> {
  const inflight = projectScanInflight.get(scanner);
  if (inflight) return inflight;

  const promise = scanner.scanDirectory()
    .then((projects) => {
      projectScanCache.set(scanner, { value: { key: projectScanKey(projects), projects }, refreshAt: Date.now() + PROJECT_REFRESH_MS });
      return projects;
    })
    .finally(() => projectScanInflight.delete(scanner));
  projectScanInflight.set(scanner, promise);
  return promise;
}

function readCachedProjects(scanner: ProjectScanner): { key: string; projects: BeadsProject[] } | null {
  const cached = projectScanCache.get(scanner);
  if (!cached) {
    emit(makeLogEntry("api", "graph.project_cache", "info", undefined, { hit: false }));
    return null;
  }
  if (cached.refreshAt <= Date.now()) void scanProjects(scanner);
  emit(makeLogEntry("api", "graph.project_cache", "info", undefined, { hit: true }));
  return cached.value;
}

function projectScanKey(projects: BeadsProject[]): string {
  return projects.map((project) => `${project.id}:${project.name}:${project.beadsPath}`).sort().join("|");
}

function issueCacheKey(project: BeadsProject, includeClosed: boolean): string {
  const projectEpoch = projectIssueEpochs.get(project.id) ?? 0;
  // includeClosed is part of the key because the Dolt query shape differs
  // (open-set vs full-set), so the two views must cache independently
  // (Codex forge-w8ya — previously include_closed=true returned the
  // non-closed cache and silently regressed the endpoint contract).
  return `${project.id}:${globalIssueEpoch}:${projectEpoch}:${includeClosed ? "all" : "open"}`;
}

function readCachedIssues(project: BeadsProject, includeClosed: boolean): { key: string; issues: BeadIssue[]; freshness: "fresh" | "stale" | "degraded" } {
  const key = issueCacheKey(project, includeClosed);
  const cached = issueCache.get(key);
  if (cached) {
    const expired = cached.refreshAt <= Date.now();
    if (expired) void refreshIssues(project, includeClosed);
    emit(makeLogEntry("api", "graph.issue_cache", "info", undefined, { projectId: project.id, includeClosed, hit: true, expired }));
    return { key, issues: cached.value.issues, freshness: expired && cached.value.freshness === "fresh" ? "stale" : cached.value.freshness };
  }
  emit(makeLogEntry("api", "graph.issue_cache", "info", undefined, { projectId: project.id, includeClosed, hit: false }));
  void refreshIssues(project, includeClosed);
  return { key, issues: [], freshness: "stale" };
}

async function refreshIssues(project: BeadsProject, includeClosed: boolean): Promise<void> {
  const key = issueCacheKey(project, includeClosed);
  const inflight = issueInflight.get(key);
  if (inflight) return;

  const promise = readIssues(project, includeClosed)
    .then((issues) => {
      issueCache.set(key, { value: { key, issues, freshness: "fresh" }, refreshAt: Date.now() + ISSUE_REFRESH_MS });
      pruneIssueCache();
    })
    .catch(() => {
      const cached = issueCache.get(key);
      if (cached) cached.value = { ...cached.value, freshness: "degraded" };
    })
    .finally(() => issueInflight.delete(key));
  issueInflight.set(key, promise);
  await promise;
}

function pruneIssueCache(maxEntries = 100): void {
  while (issueCache.size > maxEntries) {
    const oldest = issueCache.keys().next().value;
    if (oldest === undefined) return;
    issueCache.delete(oldest);
  }
}

function getScanner(): ProjectScanner {
  if (!scannerInstance) {
    const searchPath = process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home");
    scannerInstance = new ProjectScanner({ searchPath, maxDepth: 5, excludePatterns: ["node_modules", ".git", "Library", "Applications", ".cargo", ".npm", ".rustup"] });
  }
  return scannerInstance;
}

function getObservabilityDao() {
  if (!observabilityWarm) {
    observabilityWarm = (async () => {
      const repos = listRepos();
      observabilityDao = repos.length > 0 ? createObservabilityDao(createAttachPool(repos)) : null;
    })().catch(() => undefined);
  }
  return observabilityDao;
}

export function resolveProject(projects: BeadsProject[], projectId: string | null | undefined): BeadsProject | null {
  const normalizedProjectId = projectId?.trim();
  if (!normalizedProjectId) return null;

  const match = projects.find((project) => project.id === normalizedProjectId || project.name === normalizedProjectId);
  return match ?? null;
}

// Status values considered "active" for the default graph view (Codex forge-w8ya:
// `in_review` was previously omitted and silently dropped from graph nodes/edges).
// Keep in sync with normalizeStatus() below — drop only "closed" from the live set.
const ACTIVE_GRAPH_STATUSES = ["open", "in_progress", "in_review", "blocked", "deferred"] as const;

async function readIssues(project: BeadsProject, includeClosed: boolean): Promise<BeadIssue[]> {
  const startedAt = performance.now();
  if (project.doltPort) {
    const client = new DoltClient({ host: process.env.DOLT_HOST ?? (process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1"), port: project.doltPort, database: project.doltDatabase ?? "dolt" });
    try {
      // For the default graph view (include_closed=false) push the status filter
      // to SQL — projects with thousands of closed issues otherwise blow past the
      // row cap before all active ones are returned (specialists: 65 open + 2071
      // closed; the original limit:1000 unfiltered query returned only ~7 open).
      // When include_closed=true we MUST return closed rows too, so omit the filter
      // (Codex forge-w8ya — restoring endpoint contract).
      const issues = includeClosed
        ? await client.getIssues({ limit: 2000 })
        : await client.getIssues({ status: [...ACTIVE_GRAPH_STATUSES], limit: 2000 });
      emit(makeLogEntry("dolt", "graph.source.timing", "info", undefined, { projectId: project.id, source: "dolt", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
      return issues;
    } catch {
      const issues = await readIssuesFromJsonl(project.beadsPath);
      emit(makeLogEntry("dolt", "graph.source.timing", "warn", undefined, { projectId: project.id, source: "jsonl", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
      return issues;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }
  const issues = await readIssuesFromJsonl(project.beadsPath);
  emit(makeLogEntry("api", "graph.source.timing", "info", undefined, { projectId: project.id, source: "jsonl", ms: Math.round(performance.now() - startedAt), rows: issues.length }));
  return issues;
}

function resolveXtrmSource(db: Database, projectId: string | null | undefined): { sourceKey: string; projectId: string; path: string } | null {
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
  const sourceProjectId = row.source_key.replace(/^beads:/, "");
  return { sourceKey: row.source_key, projectId: sourceProjectId, path: row.path };
}

function projectNameFromBeadsPath(path: string): string {
  return basename(path) === ".beads" ? basename(dirname(path)) : basename(path);
}

function readXtrmIssues(db: Database, projectId: string, includeClosed: boolean): BeadIssue[] {
  const where = includeClosed
    ? "repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')"
    : "repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '') AND state <> 'closed'";
  const rows = db.query(`
    SELECT issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at
    FROM substrate_issues
    WHERE ${where}
    ORDER BY priority ASC, created_at DESC, issue_id ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  const dependencyTargets = db.query(`
    SELECT issue_id, title, state, issue_type
    FROM substrate_issues
    WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')
  `).all(projectId) as Array<Record<string, unknown>>;
  const dependencyTargetIndex = new Map(dependencyTargets.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = new Map<string, BeadDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    const target = dependencyTargetIndex.get(dep.dep_issue_id);
    list.push({
      id: dep.dep_issue_id,
      title: target == null ? "" : String(target.title ?? ""),
      status: target == null ? "open" : String(target.state ?? "open"),
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
    status: String(row.state ?? "open"),
    priority: Number(row.priority ?? 2),
    issue_type: String(row.issue_type ?? "task"),
    owner: row.owner == null ? null : String(row.owner),
    created_at: String(row.created_at ?? new Date(0).toISOString()),
    created_by: null,
    updated_at: String(row.updated_at ?? new Date(0).toISOString()),
    closed_at: row.closed_at == null ? (row.deleted_at == null ? undefined : String(row.deleted_at)) : String(row.closed_at),
    close_reason: row.close_reason == null ? undefined : String(row.close_reason),
    project_id: projectId,
    dependencies: depsByIssue.get(String(row.issue_id)) ?? [],
    parent_id: row.parent_id == null ? undefined : String(row.parent_id),
    related_ids: parseJsonStringArray(row.related_ids),
    labels: parseJsonStringArray(row.labels),
  }));
}

function readXtrmSpecialists(db: Database, projectId: string): SpecialistJob[] {
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
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: null,
    tools: null,
    model: null,
  }));
}

function readXtrmMaterializationState(db: Database, sourceKey: string): { last_success_at: string | null; last_status: string | null; last_error: string | null } | null {
  return db.query("SELECT last_success_at, last_status, last_error FROM materialization_state WHERE source_key = ?").get(sourceKey) as { last_success_at: string | null; last_status: string | null; last_error: string | null } | null;
}

function stateTimestampFallback(): string {
  return new Date(0).toISOString();
}

function graphHealthFromMaterialization(state: ReturnType<typeof readXtrmMaterializationState>): { freshness: "fresh" | "stale" | "degraded"; sourceHealth: SourceHealth } {
  const ageSeconds = state?.last_success_at ? Math.max(0, Math.floor((Date.now() - Date.parse(state.last_success_at)) / 1000)) : null;
  const metadata = { last_status: state?.last_status ?? null, last_success_at: state?.last_success_at ?? null, age_seconds: ageSeconds };
  if (!state?.last_success_at) return { freshness: "stale", sourceHealth: makeSourceHealth("graph", "degraded", { metadata }) };
  if (state.last_status === "error") return { freshness: "fresh", sourceHealth: makeSourceHealth("graph", "degraded", { message: "Graph source materialization failed.", metadata }) };
  if (state.last_status === "success") return { freshness: "fresh", sourceHealth: makeSourceHealth("graph", "fresh", { metadata }) };
  return { freshness: "stale", sourceHealth: makeSourceHealth("graph", "stale", { metadata }) };
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

function buildGraph(project: BeadsProject, issues: BeadIssue[], specialists: SpecialistJob[], includeClosed: boolean): GraphResponse {
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
  for (const id of supersededTargets) visibleIds.add(id);
  for (const id of ghostNodes.keys()) visibleIds.add(id);

  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const nodes = [...visibleIds].map((id) => {
    const issue = issueMap.get(id);
    if (issue) {
      return {
        id: issue.id,
        title: issue.title,
        type: normalizeNodeType(issue.issue_type),
        priority: issue.priority as GraphNode["priority"],
        status: normalizeStatus(issue.status),
        assignee: issue.owner,
        closed_at: issue.closed_at ?? null,
        superseded_by: null,
      };
    }
    return ghostNodes.get(id) ?? null;
  }).filter((node): node is GraphNode => node !== null);
  const supersededBy = new Map(edges.filter((edge) => edge.type === "supersedes").map((edge) => [edge.to, edge.from]));
  const specialistsOverlay = specialists.filter((job) => LIVE_STATUSES.has(job.status)).map(toSpecialist);

  return {
    project_id: project.id,
    repo_slug: project.name,
    generated_at: new Date().toISOString(),
    nodes: nodes.map((node) => ({ ...node, superseded_by: supersededBy.get(node.id) ?? null })),
    edges,
    specialists: specialistsOverlay,
  };
}

function toSpecialist(job: SpecialistJob): GraphSpecialist {
  return {
    bead_id: job.beadId,
    job_id: job.jobId ?? job.beadId,
    role: job.chainKind ?? job.specialist ?? "executor",
    status: normalizeSpecialistStatus(job.status),
    updated_at: job.updatedAt,
  };
}

function normalizeSpecialistStatus(status: string): GraphSpecialist["status"] {
  if (status === "starting" || status === "running" || status === "waiting" || status === "done" || status === "error" || status === "cancelled") return status;
  return "waiting";
}

function normalizeEdge(fromId: string, dependency: BeadDependency): GraphEdge | null {
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
  if (status === "open" || status === "in_progress" || status === "blocked" || status === "closed" || status === "deferred") return status;
  if (status === "in_review") return "in_progress";
  return "open";
}

function emptyGraph(projectId: string, project?: string): GraphResponse & { project?: string } {
  return { project_id: projectId, repo_slug: projectId, generated_at: new Date().toISOString(), nodes: [], edges: [], specialists: [], ...(project ? { project } : {}) };
}

function projectFallbackNote(projectId: string | null | undefined, projects: BeadsProject[]): string | undefined {
  if (projectId) {
    const available = projects.map((project) => project.name || project.id).filter(Boolean).slice(0, 5).join(",");
    return available ? `missing-project:${projectId}:available:${available}` : `missing-project:${projectId}`;
  }
  const selected = projects[0]?.name ?? projects[0]?.id;
  return selected ? `fallback:selected-repo:${selected}` : "fallback:no-selected-repo";
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
