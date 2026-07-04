import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, makeLogEntry } from "../../core/logger.ts";
import { BeadsReader } from "../../core/beads-reader.ts";
import { DoltClient } from "../../core/dolt-client.ts";
import { formatSourceDisplayPath } from "./sources-policy.ts";
import type { BeadDependency, BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../../types/beads.ts";
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

const loggedProjectMemories = new Set<string>();
const loggedProjectInteractions = new Set<string>();

export function createSubstrateRouter(xtrmDb?: Database | null): Hono {
  const router = new Hono();

  router.get("/projects", (c) => c.json({ projects: readProjects(xtrmDb) }));
  router.get("/projects/:projectId/issues", (c) => c.json({ issues: readIssues(xtrmDb, c.req.param("projectId"), parseIssueFilters(c)) }));
  router.get("/projects/:projectId/issues/closed", (c) => c.json({ issues: readClosedIssues(xtrmDb, c.req.param("projectId"), parseLimit(c.req.query("limit"), 50) ?? 50) }));
  router.get("/projects/:projectId/issues/:issueId", (c) => {
    const issue = readIssueDetail(xtrmDb, c.req.param("projectId"), c.req.param("issueId"));
    return issue ? c.json({ issue }) : c.json({ error: "Issue not found" }, 404);
  });
  router.get("/projects/:projectId/memories", async (c) => c.json({ memories: await readMemories(xtrmDb, c.req.param("projectId")) }));
  router.get("/projects/:projectId/interactions", async (c) => c.json({ interactions: await readInteractions(xtrmDb, c.req.param("projectId"), c.req.query("issue_id") ?? undefined) }));
  router.get("/projects/:projectId/runtime-graph", (c) => c.json(readRuntimeGraph(xtrmDb, c.req.param("projectId"))));
  router.get("/projects/:projectId/stats", (c) => c.json({ stats: readStats(xtrmDb, c.req.param("projectId")) }));
  router.get("/projects/:projectId/connection", async (c) => c.json(await readConnection(xtrmDb, c.req.param("projectId"))));
  router.get("/projects/:projectId/repair-actions", async (c) => c.json(await readRepairActions(xtrmDb, c.req.param("projectId"))));

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

async function readMemories(db: Database | null | undefined, projectId: string): Promise<Memory[]> {
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  if (!beadsPath) return [];
  const memories = await new BeadsReader(db as Database).getMemories(`${beadsPath}/knowledge.jsonl`);
  if (memories.length === 0) {
    logEmptyOrMissingProjectData(loggedProjectMemories, "substrate.readMemories", projectId, beadsPath);
  } else {
    logProjectDataOnce(loggedProjectMemories, "substrate.readMemories", projectId, beadsPath, memories.length);
  }
  return memories;
}

async function readInteractions(db: Database | null | undefined, projectId: string, issueId?: string): Promise<Interaction[]> {
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  if (!beadsPath) return [];
  const interactions = await new BeadsReader(db as Database).getInteractions(`${beadsPath}/interactions.jsonl`);
  const filtered = issueId ? interactions.filter((interaction) => interaction.issue_id === issueId) : interactions;
  if (filtered.length === 0) {
    logEmptyOrMissingProjectData(loggedProjectInteractions, "substrate.readInteractions", projectId, beadsPath);
  } else {
    logProjectDataOnce(loggedProjectInteractions, "substrate.readInteractions", projectId, beadsPath, filtered.length);
  }
  return filtered;
}
function readStats(db: Database | null | undefined, projectId: string) {
  return coreReadSubstrateStats(db, projectId);
}

async function readConnection(db: Database | null | undefined, projectId: string): Promise<Record<string, unknown>> {
  if (!db) return { source: "none", status: "error", degraded: true, error: "xtrm.sqlite unavailable" };
  const row = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND source_key = ?").get(`beads:${projectId}`) as { source_key: string; path: string } | undefined;
  if (!row) return { source: "none", status: "not_found", degraded: true, error: "Project not found" };
  const facts = readBeadsSourceFacts(row.path);
  const state = coreReadSourceMaterializationState(db, row.source_key);
  const base = {
    port: facts.doltPort,
    database: facts.doltDatabase,
    pid: facts.doltPid,
    pid_alive: facts.doltPidAlive,
    jsonl_updated_at: facts.jsonlUpdatedAt,
    last_success_at: state?.last_success_at ?? null,
    last_error: state?.last_error ?? null,
  };
  if (!facts.doltPort) {
    return { ...base, source: "jsonl", status: "jsonl_fallback", degraded: true, note: "No Dolt port configured; reading materialized JSONL backup." };
  }
  const client = new DoltClient({ host: process.env.DOLT_HOST ?? (process.env.XDG_PROJECTS_DIR ? "host.docker.internal" : "127.0.0.1"), port: facts.doltPort, database: facts.doltDatabase ?? "dolt" });
  try {
    await client.connect();
    return { ...base, source: "dolt", status: "dolt_connected", degraded: state?.last_status === "error", message: state?.last_error ?? `Dolt connected:${facts.doltPort}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = facts.doltPidAlive === false ? "dolt_process_dead" : "dolt_unreachable";
    return { ...base, source: "jsonl", status, degraded: true, error: state?.last_error ?? message, note: "Dolt unavailable; using materialized/JSONL fallback." };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function readRepairActions(db: Database | null | undefined, projectId: string): Promise<{ projectId: string; status: string; actions: BeadsRepairAction[] }> {
  const connection = await readConnection(db, projectId);
  const beadsPath = coreGetBeadsSourcePath(db, projectId);
  const facts = beadsPath ? readBeadsSourceFacts(beadsPath) : null;
  const projectRef = facts?.repoPath ? formatSourceDisplayPath(facts.repoPath) : "<repo>";
  const bd = `bd -C ${shellQuote(projectRef)} dolt`;
  const status = String(connection.status ?? "error");
  const hasProject = facts != null;
  const hasPort = facts?.doltPort != null;
  const deadPid = facts?.doltPid != null && facts.doltPidAlive === false;
  const sharedPortPath = "~/.beads/shared-server/dolt-server.port";
  const localPortPath = ".beads/dolt-server.port";

  return {
    projectId,
    status,
    actions: [
      {
        id: "rescan_source_health",
        label: "Rescan source health",
        description: "Refresh the project connection probe and source-health projection without mutating Beads data.",
        endpoint: `/api/substrate/projects/${encodeURIComponent(projectId)}/connection`,
        available: hasProject,
        disabledReason: hasProject ? undefined : "Project not found",
      },
      {
        id: "inspect_dolt_status",
        label: "Inspect Dolt status",
        description: "Check the Dolt server configuration and connection from the project directory.",
        command: `${bd} status && ${bd} show`,
        available: hasProject,
        disabledReason: hasProject ? undefined : "Project not found",
      },
      {
        id: "start_dolt_server",
        label: "Start Dolt server",
        description: "Start the project Dolt SQL server when no reachable server is detected.",
        command: `${bd} start && ${bd} test`,
        available: hasProject && !hasPort,
        disabledReason: hasProject && hasPort ? "Dolt port is already configured; use restart if it is unreachable." : hasProject ? undefined : "Project not found",
      },
      {
        id: "restart_dolt_server",
        label: "Restart Dolt server",
        description: "Restart Dolt when the configured port is unreachable or the pid file points at a dead process.",
        command: `${bd} stop && ${bd} start && ${bd} test`,
        available: hasProject && hasPort && status !== "dolt_connected",
        disabledReason: hasProject && status === "dolt_connected" ? "Dolt is currently reachable." : hasProject ? undefined : "Project not found",
      },
      {
        id: "recover_port_config",
        label: "Recover port config",
        description: facts?.sharedServerEnabled
          ? "Shared-server repos read their port from the user-level shared-server file."
          : "Project-local repos should have a Dolt port recorded in .beads config or the local port file.",
        command: facts?.sharedServerEnabled
          ? `test -s ${sharedPortPath} && cat ${sharedPortPath} || bd dolt start`
          : `test -s ${localPortPath} && cat ${localPortPath} || ${bd} start`,
        available: hasProject && !hasPort,
        disabledReason: hasProject && hasPort ? `Port ${facts?.doltPort} is already configured.` : hasProject ? undefined : "Project not found",
      },
      {
        id: "remove_dead_pid_file",
        label: "Remove dead pid file",
        description: "Clear stale Dolt pid files only after the pid is confirmed dead, then restart Dolt.",
        command: facts?.sharedServerEnabled
          ? "rm -f ~/.beads/shared-server/dolt-server.pid && bd dolt start"
          : `rm -f .beads/dolt-server.pid && ${bd} start`,
        available: hasProject && deadPid,
        disabledReason: hasProject && !deadPid ? "No dead Dolt pid file detected." : hasProject ? undefined : "Project not found",
      },
    ],
  };
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

type BeadsSourceFacts = {
  repoPath: string;
  projectName: string;
  doltPort?: number;
  doltDatabase?: string;
  doltPid?: number;
  doltPidAlive?: boolean;
  sharedServerEnabled: boolean;
  jsonlUpdatedAt?: string;
};

type BeadsRepairAction = {
  id: "rescan_source_health" | "inspect_dolt_status" | "start_dolt_server" | "restart_dolt_server" | "recover_port_config" | "remove_dead_pid_file";
  label: string;
  description: string;
  command?: string;
  endpoint?: string;
  available: boolean;
  disabledReason?: string;
};

function readBeadsSourceFacts(beadsPath: string): BeadsSourceFacts {
  const repoPath = beadsPath.endsWith("/.beads") ? dirname(beadsPath) : beadsPath;
  const projectName = repoPath.split("/").filter(Boolean).at(-1) ?? beadsPath;
  const metadata = readJsonFile(join(beadsPath, "metadata.json"));
  const config = readTextFile(join(beadsPath, "config.yaml")) ?? "";
  const sharedServerEnabled = /dolt\.shared-server:\s*true|shared-server:\s*true/.test(config);
  const configuredPort = numberFromMatch(config.match(/port:\s*(\d+)/));
  const sharedPort = sharedServerEnabled ? readSharedServerPort() : undefined;
  const doltPort = sharedPort ?? (sharedServerEnabled ? undefined : configuredPort);
  const doltDatabase = stringFromMatch(config.match(/dolt_database:\s*(\S+)/)) ?? stringFromRecord(metadata, "dolt_database");
  const doltPid = readDoltPid(beadsPath);
  return {
    repoPath,
    projectName,
    doltPort,
    doltDatabase,
    doltPid,
    doltPidAlive: isPidAlive(doltPid),
    sharedServerEnabled,
    jsonlUpdatedAt: mtimeIso(join(beadsPath, "issues.jsonl")),
  };
}

function readSharedServerPort(): number | undefined {
  const path = process.env.HOME ? join(process.env.HOME, ".beads/shared-server/dolt-server.port") : null;
  if (!path) return undefined;
  const value = Number(readTextFile(path)?.trim());
  return Number.isFinite(value) ? value : undefined;
}

function readDoltPid(beadsPath: string): number | undefined {
  const candidates = [
    join(beadsPath, "dolt-server.pid"),
    process.env.HOME ? join(process.env.HOME, ".beads/shared-server/dolt-server.pid") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = Number(readTextFile(candidate)?.trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function isPidAlive(pid: number | undefined): boolean | undefined {
  if (pid == null) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readTextFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  const text = readTextFile(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function numberFromMatch(match: RegExpMatchArray | null): number | undefined {
  const value = match?.[1] == null ? NaN : Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function stringFromMatch(match: RegExpMatchArray | null): string | undefined {
  return match?.[1] || undefined;
}

function stringFromRecord(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function logEmptyOrMissingProjectData(seen: Set<string>, event: string, projectId: string, beadsPath: string): void {
  const key = `${projectId}:${beadsPath}:empty-or-missing`;
  if (seen.has(key)) return;
  seen.add(key);
  emit(makeLogEntry("api", event, "debug", undefined, { projectId, path: beadsPath, status: "empty-or-missing" }));
}

function logProjectDataOnce<T>(seen: Set<string>, event: string, projectId: string, beadsPath: string, count: number): void {
  const key = `${projectId}:${beadsPath}`;
  if (seen.has(key)) return;
  seen.add(key);
  emit(makeLogEntry("api", event, "info", undefined, { projectId, path: beadsPath, count }));
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
