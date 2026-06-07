import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, makeLogEntry } from "../../core/logger.ts";
import { BeadsReader } from "../../core/beads-reader.ts";
import { DoltClient } from "../../core/dolt-client.ts";
import { formatSourceDisplayPath } from "./sources-policy.ts";
import type { BeadDependency, BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../../types/beads.ts";

let loggedSchemaColumns = false;
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
    const state = readMaterializationState(db, row.source_key);
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
      issueCount: countIssues(db, id),
      sourceHealth: [{ kind: facts.doltPort ? "dolt" : "jsonl", state: healthState, detail: state?.last_error ?? undefined }],
    } satisfies BeadsProject;
  });
}

function readIssues(db: Database | null | undefined, projectId: string, filters: { status?: string[]; priority?: number[]; search?: string; limit?: number }): BeadIssue[] {
  const issues = queryIssues(db, projectId);
  return applyIssueFilters(issues, filters);
}

function readClosedIssues(db: Database | null | undefined, projectId: string, limit: number): BeadIssue[] {
  if (!db) return [];
  logSchemaColumnsOnce(db);
  const rows = db.query(`
    SELECT issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at
    FROM substrate_issues
    WHERE repo_slug = ?
      AND state = 'closed'
      AND (deleted_at IS NULL OR deleted_at = '')
    ORDER BY COALESCE(closed_at, updated_at, created_at) DESC, issue_id ASC
    LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>;
  const issueIndex = new Map(rows.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = new Map<string, BeadDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    const target = issueIndex.get(dep.dep_issue_id);
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
    related_ids: parseJsonArray(row.related_ids),
    labels: parseJsonArray(row.labels),
  }));
}

function readIssueDetail(db: Database | null | undefined, projectId: string, issueId: string): BeadIssueDetail | null {
  const issue = queryIssues(db, projectId).find((row) => row.id === issueId);
  if (!issue) return null;
  const dependents = queryDependents(db, projectId, issueId);
  return { ...issue, dependents, children: dependents.filter((dep) => dep.dependency_type === "parent-child"), source: "unknown", sourceHealth: [{ kind: "unknown", state: "fresh" }] };
}

async function readMemories(db: Database | null | undefined, projectId: string): Promise<Memory[]> {
  const beadsPath = getBeadsPath(db, projectId);
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
  const beadsPath = getBeadsPath(db, projectId);
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
  const issues = queryIssues(db, projectId);
  type Stats = { total: number; open: number; in_progress: number; blocked: number; closed: number; by_priority: Record<string, number>; by_type: Record<string, number> };
  return issues.reduce<Stats>((acc, issue) => {
    acc.total += 1;
    if (issue.status in acc) acc[issue.status as keyof Omit<Stats, "by_priority" | "by_type">] += 1;
    return acc;
  }, { total: 0, open: 0, in_progress: 0, blocked: 0, closed: 0, by_priority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }, by_type: { bug: 0, feature: 0, task: 0, epic: 0, chore: 0 } });
}

async function readConnection(db: Database | null | undefined, projectId: string): Promise<Record<string, unknown>> {
  if (!db) return { source: "none", status: "error", degraded: true, error: "xtrm.sqlite unavailable" };
  const row = db.query("SELECT source_key, path FROM sources WHERE kind = 'beads' AND source_key = ?").get(`beads:${projectId}`) as { source_key: string; path: string } | undefined;
  if (!row) return { source: "none", status: "not_found", degraded: true, error: "Project not found" };
  const facts = readBeadsSourceFacts(row.path);
  const state = readMaterializationState(db, row.source_key);
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
  const beadsPath = getBeadsPath(db, projectId);
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
  if (!db) return { nodes: [], edges: [] };
  const rows = db.query(`
    SELECT issue_id, title, state, priority, issue_type, labels, parent_id, runtime_kind,
           formula_name, template_name, contract_kind, contract_xml, metadata_json,
           created_at, updated_at
    FROM substrate_issues
    WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '')
    ORDER BY issue_id ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  const edges = db.query(`
    SELECT from_issue_id, to_issue_id, relation
    FROM substrate_issue_edges
    WHERE repo_slug = ?
    ORDER BY from_issue_id ASC, to_issue_id ASC, relation ASC
  `).all(projectId) as Array<{ from_issue_id: string; to_issue_id: string; relation: string }>;

  return {
    nodes: rows.map((row) => ({
      id: String(row.issue_id),
      title: String(row.title ?? ""),
      state: String(row.state ?? "open"),
      priority: Number(row.priority ?? 2),
      issue_type: String(row.issue_type ?? "task"),
      labels: parseJsonArray(row.labels),
      parent_id: row.parent_id == null ? null : String(row.parent_id),
      runtime_kind: String(row.runtime_kind ?? deriveRuntimeKindFromRow(row)),
      formula_name: row.formula_name == null ? null : String(row.formula_name),
      template_name: row.template_name == null ? null : String(row.template_name),
      contract_kind: row.contract_kind == null ? null : String(row.contract_kind),
      contract_xml: row.contract_xml == null ? null : String(row.contract_xml),
      metadata: parseJsonObject(row.metadata_json),
      created_at: row.created_at == null ? null : String(row.created_at),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    })),
    edges: edges.map((edge) => ({ from: edge.from_issue_id, to: edge.to_issue_id, relation: edge.relation })),
  };
}

function getBeadsPath(db: Database | null | undefined, projectId: string): string | null {
  if (!db) return null;
  const row = db.query("SELECT path FROM sources WHERE kind = 'beads' AND source_key = ?").get(`beads:${projectId}`) as { path: string } | undefined;
  return row?.path ?? null;
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

function readMaterializationState(db: Database, sourceKey: string): { last_status: string | null; last_success_at: string | null; last_error: string | null } | null {
  return db.query("SELECT last_status, last_success_at, last_error FROM materialization_state WHERE source_key = ?").get(sourceKey) as { last_status: string | null; last_success_at: string | null; last_error: string | null } | null;
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

function queryIssues(db: Database | null | undefined, projectId: string): BeadIssue[] {
  if (!db) return [];
  logSchemaColumnsOnce(db);
  const rows = db.query("SELECT issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '') ORDER BY priority ASC, created_at DESC, issue_id ASC").all(projectId) as Array<Record<string, unknown>>;
  const issueIndex = new Map(rows.map((row) => [String(row.issue_id), row] as const));
  const dependencies = db.query("SELECT issue_id, dep_issue_id, relation FROM substrate_dependencies WHERE repo_slug = ?").all(projectId) as Array<{ issue_id: string; dep_issue_id: string; relation: string }>;
  const depsByIssue = new Map<string, BeadDependency[]>();
  for (const dep of dependencies) {
    const list = depsByIssue.get(dep.issue_id) ?? [];
    const target = issueIndex.get(dep.dep_issue_id);
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
    related_ids: parseJsonArray(row.related_ids),
    labels: parseJsonArray(row.labels),
  }));
}

function logSchemaColumnsOnce(db: Database): void {
  if (loggedSchemaColumns) return;
  loggedSchemaColumns = true;
  const columns = db.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>;
  emit(makeLogEntry("api", "substrate.queryIssues", "info", undefined, { schema_columns: columns.map((column) => column.name) }));
}

function readSchema(db?: Database | null) {
  if (!db) return { columns: [], counts: { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } };
  const columns = (db.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>).map((column) => column.name);
  const counts = db.query("SELECT COALESCE(SUM(CASE WHEN priority IS NOT NULL AND priority <> 2 THEN 1 ELSE 0 END), 0) AS with_priority_nonzero, COALESCE(SUM(CASE WHEN issue_type IS NOT NULL AND issue_type <> 'task' THEN 1 ELSE 0 END), 0) AS with_type_nontask, COALESCE(SUM(CASE WHEN labels IS NOT NULL AND labels <> '[]' AND labels <> '' THEN 1 ELSE 0 END), 0) AS with_labels, COALESCE(SUM(CASE WHEN related_ids IS NOT NULL AND related_ids <> '[]' AND related_ids <> '' THEN 1 ELSE 0 END), 0) AS with_related FROM substrate_issues").get() as { with_priority_nonzero: number; with_type_nontask: number; with_labels: number; with_related: number } | undefined;
  return { columns, counts: counts ?? { with_priority_nonzero: 0, with_type_nontask: 0, with_labels: 0, with_related: 0 } };
}

function parseJsonArray(value: unknown): string[] {
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function deriveRuntimeKindFromRow(row: Record<string, unknown>): string {
  const labels = parseJsonArray(row.labels);
  const issueType = String(row.issue_type ?? "task");
  if (issueType === "molecule" || labels.includes("kind:molecule")) return "chain_molecule";
  if (labels.includes("kind:step")) return "step";
  if (issueType === "epic") return "organizational_epic";
  return "root";
}

function queryDependents(db: Database | null | undefined, projectId: string, issueId: string): BeadDependency[] {
  if (!db) return [];
  const rows = db.query("SELECT issue_id, relation FROM substrate_dependencies WHERE repo_slug = ? AND dep_issue_id = ? ORDER BY issue_id ASC").all(projectId, issueId) as Array<{ issue_id: string; relation: string }>;
  if (rows.length === 0) return [];
  const dependentIds = [...new Set(rows.map((row) => row.issue_id))];
  const dependentRows = db.query(
    `SELECT issue_id, title, state, issue_type
     FROM substrate_issues
     WHERE repo_slug = ? AND (deleted_at IS NULL OR deleted_at = '') AND issue_id IN (${dependentIds.map(() => "?").join(",")})`,
  ).all(projectId, ...dependentIds) as Array<{ issue_id: string; title: string | null; state: string | null; issue_type: string | null }>;
  const dependentById = new Map(dependentRows.map((row) => [row.issue_id, row] as const));

  return rows.map((row) => {
    const dependent = dependentById.get(row.issue_id);
    return {
      id: row.issue_id,
      title: dependent == null ? "" : String(dependent.title ?? ""),
      status: dependent == null ? "open" : String(dependent.state ?? "open"),
      issue_type: dependent == null ? undefined : String(dependent.issue_type ?? "task"),
      dependency_type: row.relation,
    };
  });
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
  return filters.limit == null ? filtered : filtered.slice(0, filters.limit);
}

function parseIssueFilters(c: { req: { query(name: string): string | undefined } }) {
  return {
    status: c.req.query("status")?.split(","),
    priority: c.req.query("priority")?.split(",").map(Number),
    search: c.req.query("search") ?? undefined,
    limit: parseLimit(c.req.query("limit")),
  };
}

function parseLimit(value: string | undefined, fallback?: number): number | undefined {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
