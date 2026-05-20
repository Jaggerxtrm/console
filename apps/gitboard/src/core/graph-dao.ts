import { createAttachPool } from "../server/observability/attach-pool.ts";
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
let observabilityInitialized = false;

const PROJECT_SCAN_TTL_MS = 30_000;
const ISSUE_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const projectScanCache = new WeakMap<ProjectScanner, CacheEntry<BeadsProject[]>>();
const projectScanInflight = new WeakMap<ProjectScanner, Promise<BeadsProject[]>>();
const issueCache = new Map<string, CacheEntry<BeadIssue[]>>();
const issueInflight = new Map<string, Promise<BeadIssue[]>>();
const projectIssueEpochs = new Map<string, number>();
let globalIssueEpoch = 0;

export interface GraphDaoOptions {
  scanner?: ProjectScanner;
  observability?: ReturnType<typeof createObservabilityDao>;
}

export function createGraphDao(options: GraphDaoOptions = {}) {
  const scanner = options.scanner ?? getScanner();
  const dao = options.observability ?? getObservabilityDao();

  return {
    async getGraph(projectId: string | null | undefined, includeClosed = false): Promise<GraphResponse> {
      const projects = await scanProjects(scanner);
      const project = resolveProject(projects, projectId);
      if (!project) return emptyGraph(projectId ?? "", projectFallbackNote(projectId, projects));

      const issues = await readIssuesCached(project);
      const specialists = dao ? dao.inFlightJobs().filter((job) => job.repoSlug === project.id || job.repoSlug === project.name) : [];
      return buildGraph(project, issues, specialists, includeClosed);
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

async function scanProjects(scanner: ProjectScanner): Promise<BeadsProject[]> {
  const now = Date.now();
  const cached = projectScanCache.get(scanner);
  if (cached && cached.expires > now) return cached.value;

  const inflight = projectScanInflight.get(scanner);
  if (inflight) return inflight;

  const promise = scanner.scanDirectory()
    .then((projects) => {
      projectScanCache.set(scanner, { value: projects, expires: Date.now() + PROJECT_SCAN_TTL_MS });
      return projects;
    })
    .finally(() => projectScanInflight.delete(scanner));
  projectScanInflight.set(scanner, promise);
  return promise;
}

function issueCacheKey(project: BeadsProject): string {
  const source = project.source ?? "unknown";
  const port = project.doltPort ?? "jsonl";
  const projectEpoch = projectIssueEpochs.get(project.id) ?? 0;
  return `${project.id}:${project.beadsPath}:${source}:${port}:${project.doltDatabase ?? "dolt"}:${globalIssueEpoch}:${projectEpoch}`;
}

async function readIssuesCached(project: BeadsProject): Promise<BeadIssue[]> {
  const key = issueCacheKey(project);
  const now = Date.now();
  const cached = issueCache.get(key);
  if (cached && cached.expires > now) return cached.value;

  const inflight = issueInflight.get(key);
  if (inflight) return inflight;

  const promise = readIssues(project)
    .then((issues) => {
      issueCache.set(key, { value: issues, expires: Date.now() + ISSUE_CACHE_TTL_MS });
      pruneIssueCache();
      return issues;
    })
    .finally(() => issueInflight.delete(key));
  issueInflight.set(key, promise);
  return promise;
}

function pruneIssueCache(maxEntries = 100): void {
  const now = Date.now();
  for (const [key, entry] of issueCache) {
    if (entry.expires <= now) issueCache.delete(key);
  }
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
  if (observabilityInitialized) return observabilityDao;
  const repos = listRepos();
  observabilityDao = repos.length > 0 ? createObservabilityDao(createAttachPool(repos)) : null;
  observabilityInitialized = true;
  return observabilityDao;
}

function resolveProject(projects: BeadsProject[], projectId: string | null | undefined): BeadsProject | null {
  if (!projectId) return null;
  const match = projects.find((project) => project.id === projectId || project.name === projectId);
  return match ?? null;
}

async function readIssues(project: BeadsProject): Promise<BeadIssue[]> {
  if (project.doltPort) {
    const client = new DoltClient({ host: process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1", port: project.doltPort, database: project.doltDatabase ?? "dolt" });
    try {
      return await client.getIssues({ limit: 1000 });
    } catch {
      return await readIssuesFromJsonl(project.beadsPath);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }
  return await readIssuesFromJsonl(project.beadsPath);
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
