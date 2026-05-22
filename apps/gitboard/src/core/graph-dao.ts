import { createAttachPool } from "../server/observability/attach-pool.ts";
import { emit, makeLogEntry } from "./logger.ts";
import { createObservabilityDao } from "../server/observability/dao.ts";
import { listRepos } from "../server/observability/registry.ts";
import { readIssuesFromJsonl } from "./jsonl-reader.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { DoltClient } from "./dolt-client.ts";
import type { BeadDependency, BeadIssue, BeadsProject } from "../types/beads.ts";
import type { GraphEdge, GraphEdgeType, GraphNode, GraphNodeStatus, GraphNodeType, GraphResponse, GraphSpecialist } from "../types/graph.ts";
import type { SpecialistJob } from "../server/observability/types.ts";

const NODE_TYPES = new Set(["task", "bug", "feature", "epic", "chore", "decision", "molecule"]);
const LIVE_STATUSES = new Set(["starting", "running", "waiting"]);

let scannerInstance: ProjectScanner | null = null;
let observabilityDao: ReturnType<typeof createObservabilityDao> | null = null;
let observabilityWarm: Promise<void> | null = null;

const PROJECT_REFRESH_MS = 30_000;
const ISSUE_REFRESH_MS = 10_000;

interface CacheEntry<T> {
  value: T;
  refreshAt: number;
}

const projectScanCache = new WeakMap<ProjectScanner, CacheEntry<{ key: string; projects: BeadsProject[] }>>();
const projectScanInflight = new WeakMap<ProjectScanner, Promise<BeadsProject[]>>();
const issueCache = new Map<string, CacheEntry<{ key: string; issues: BeadIssue[] }>>();
const issueInflight = new Map<string, Promise<void>>();
const projectIssueEpochs = new Map<string, number>();
let globalIssueEpoch = 0;

export interface GraphDaoOptions {
  scanner?: ProjectScanner;
  observability?: ReturnType<typeof createObservabilityDao>;
}

export function createGraphDao(options: GraphDaoOptions = {}) {
  const scanner = options.scanner ?? getScanner();
  const getDao = () => options.observability ?? getObservabilityDao();

  return {
    getGraphSnapshot(projectId: string | null | undefined, includeClosed = false): { graph: GraphResponse; freshness: "fresh" | "stale" | "degraded" } {
      const startedAt = performance.now();
      void warmGraphState(scanner);
      const scan = readCachedProjects(scanner);
      if (!scan) return { graph: emptyGraph(projectId ?? "", projectFallbackNote(projectId, [])), freshness: "stale" };

      const project = resolveProject(scan.projects, projectId);
      if (!project) return { graph: emptyGraph(projectId ?? "", projectFallbackNote(projectId, scan.projects)), freshness: "fresh" };

      const issueState = readCachedIssues(project);
      const dao = getDao();
      const specialists = dao ? dao.inFlightJobs().filter((job) => job.repoSlug === project.id || job.repoSlug === project.name) : [];
      const graph = buildGraph(project, issueState.issues, specialists, includeClosed);
      emit(makeLogEntry("api", "graph.snapshot.timing", "info", undefined, { projectId: project.id, freshness: issueState.freshness, ms: Math.round(performance.now() - startedAt) }));
      return { graph, freshness: issueState.freshness };
    },
    invalidate(projectId?: string | null): void {
      projectScanCache.delete(scanner);
      projectScanInflight.delete(scanner);
      invalidateGraphCache(projectId);
    },
  };
}

export function invalidateGraphCache(projectId?: string | null): void {
  if (!projectId) {
    globalIssueEpoch += 1;
    issueCache.clear();
    issueInflight.clear();
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
}

async function warmGraphState(scanner: ProjectScanner): Promise<void> {
  void scanProjects(scanner);
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

function issueCacheKey(project: BeadsProject): string {
  const projectEpoch = projectIssueEpochs.get(project.id) ?? 0;
  return `${project.id}:${globalIssueEpoch}:${projectEpoch}`;
}

function readCachedIssues(project: BeadsProject): { issues: BeadIssue[]; freshness: "fresh" | "stale" | "degraded" } {
  const key = issueCacheKey(project);
  const cached = issueCache.get(key);
  if (cached) {
    if (cached.refreshAt <= Date.now()) void refreshIssues(project);
    emit(makeLogEntry("api", "graph.issue_cache", "info", undefined, { projectId: project.id, hit: true }));
    return { issues: cached.value.issues, freshness: cached.value.freshness };
  }
  emit(makeLogEntry("api", "graph.issue_cache", "info", undefined, { projectId: project.id, hit: false }));
  void refreshIssues(project);
  return { issues: [], freshness: "stale" };
}

async function refreshIssues(project: BeadsProject): Promise<void> {
  const key = issueCacheKey(project);
  const inflight = issueInflight.get(key);
  if (inflight) return;

  const promise = readIssues(project)
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

async function readIssues(project: BeadsProject): Promise<BeadIssue[]> {
  const startedAt = performance.now();
  if (project.doltPort) {
    const client = new DoltClient({ host: process.env.DOLT_HOST ?? (process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1"), port: project.doltPort, database: project.doltDatabase ?? "dolt" });
    try {
      // Only fetch non-closed issues for the graph. With closed included, projects
      // that have thousands of closed issues blow past the row cap before all open
      // ones are returned (specialists: 65 open + 2071 closed; the original
      // limit:1000 unfiltered query returned only ~7 open). The graph endpoint
      // defaults to include_closed=false anyway.
      const issues = await client.getIssues({ status: ["open", "in_progress", "blocked", "deferred"], limit: 2000 });
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

function buildGraph(project: BeadsProject, issues: BeadIssue[], specialists: SpecialistJob[], includeClosed: boolean): GraphResponse {
  const issueMap = new Map(issues.map((issue) => [issue.id, issue]));
  const allEdges = issues.flatMap((issue) => issue.dependencies.map((dependency) => normalizeEdge(issue.id, dependency)).filter((edge): edge is GraphEdge => edge !== null));
  const supersededTargets = new Set(allEdges.filter((edge) => edge.type === "supersedes").map((edge) => edge.to));

  const visibleIds = new Set<string>();
  for (const issue of issues) {
    if (includeClosed || issue.status !== "closed") visibleIds.add(issue.id);
  }
  for (const id of supersededTargets) visibleIds.add(id);

  const edges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const nodes = [...visibleIds].map((id) => issueMap.get(id)).filter((issue): issue is BeadIssue => issue !== undefined).map((issue) => ({
    id: issue.id,
    title: issue.title,
    type: normalizeNodeType(issue.issue_type),
    priority: issue.priority as GraphNode["priority"],
    status: normalizeStatus(issue.status),
    assignee: issue.owner,
    closed_at: issue.closed_at ?? null,
    superseded_by: null,
  }));
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
  if (projectId) return undefined;
  const selected = projects[0]?.name ?? projects[0]?.id;
  return selected ? `fallback:selected-repo:${selected}` : "fallback:no-selected-repo";
}
