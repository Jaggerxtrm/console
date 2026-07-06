import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { emit, makeLogEntry } from "../../core/logger.ts";
import type { BeadDependency, BeadIssue } from "../../types/beads.ts";
import { isAllowedConsoleWriteRequest } from "./sources-policy.ts";
import { resolveBeadsProjectRepoPath } from "../services/substrate-project-service.ts";

type WriteOutcome = "success" | "error" | "forbidden" | "invalid" | "not_found";

type BdRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type CreateIssueBody = {
  title: string;
  description?: string | null;
  priority?: number;
  type?: string;
  assignee?: string | null;
  labels?: string[];
};

type UpdateIssueBody = {
  title?: string;
  description?: string | null;
  priority?: number;
  status?: string;
  type?: string;
  assignee?: string | null;
  labels?: { add?: string[]; remove?: string[]; set?: string[] };
};

type CloseIssueBody = { reason?: string | null };
type CommentIssueBody = { text?: string | null };
type AddDependencyBody = { dependsOnIssueId?: string | null };
type SetPriorityBody = { priority?: number | null };

type BdRunner = (repoPath: string, command: string[], op: string) => Promise<BdRunResult>;
type IssueReader = (projectId: string, issueId: string) => BeadIssue | null;

export type BeadsWriteRouterOptions = {
  runBdCommand?: BdRunner;
  readIssue?: IssueReader;
};

const MUTATION_PREFIX = ["--json", "--actor", "console", "--dolt-auto-commit", "on"] as const;
const BD_BIN = process.env.GITBOARD_BD_BIN || "bd";
const SAFE_IDENTIFIER_PATTERN = /^(?!-)[^\s/\\\x00-\x1F\x7F]+$/;
const SAFE_ENUM_TOKEN_PATTERN = /^(?!-)[A-Za-z0-9_]+$/;
const MAX_BD_DIAGNOSTIC_LENGTH = 160;

export function createBeadsWriteRouter(xtrmDb?: Database | null, options: BeadsWriteRouterOptions = {}): Hono {
  const router = new Hono();
  const runBdCommand = options.runBdCommand ?? defaultRunBdCommand;
  const readIssue = options.readIssue ?? createIssueReader(xtrmDb);

  router.post("/projects/:projectId/issues", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<CreateIssueBody>(c.req.raw);
    if (!body || !isNonEmptyString(body.title)) return writeError(c, "create", "invalid", "title is required", 400);
    if (body.priority != null && !isPriority(body.priority)) return writeError(c, "create", "invalid", "priority must be integer 0-4", 400);
    if (body.labels != null && !isStringArray(body.labels)) return writeError(c, "create", "invalid", "labels must be string[]", 400);
    if (body.assignee != null && typeof body.assignee !== "string") return writeError(c, "create", "invalid", "assignee must be string|null", 400);
    if (body.description != null && typeof body.description !== "string") return writeError(c, "create", "invalid", "description must be string|null", 400);
    if (body.type != null && !isSafeCliToken(body.type)) return writeError(c, "create", "invalid", "type must be safe token", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "create", "invalid", "invalid projectId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "create", "not_found", "Project not found", 404, { projectId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "create", body.title];
    if (body.description) args.push("--description", body.description);
    if (body.priority != null) args.push("--priority", String(body.priority));
    if (body.type) args.push("--type", body.type);
    if (body.assignee) args.push("--assignee", body.assignee);
    for (const label of body.labels ?? []) args.push("--label", label);

    return await runIssueMutation({ c, projectId, op: "create", repoPath, args, runBdCommand, readIssue });
  });

  router.patch("/projects/:projectId/issues/:issueId", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<UpdateIssueBody>(c.req.raw);
    if (!body) return writeError(c, "update", "invalid", "Invalid JSON body", 400);
    if (body.title != null && !isNonEmptyString(body.title)) return writeError(c, "update", "invalid", "title must be non-empty string", 400);
    if (body.description != null && typeof body.description !== "string") return writeError(c, "update", "invalid", "description must be string|null", 400);
    if (body.priority != null && !isPriority(body.priority)) return writeError(c, "update", "invalid", "priority must be integer 0-4", 400);
    if (body.status != null && !isSafeCliToken(body.status)) return writeError(c, "update", "invalid", "status must be safe token", 400);
    if (body.type != null && !isSafeCliToken(body.type)) return writeError(c, "update", "invalid", "type must be safe token", 400);
    if (body.assignee != null && typeof body.assignee !== "string") return writeError(c, "update", "invalid", "assignee must be string|null", 400);
    if (body.labels && !isLabelPatch(body.labels)) return writeError(c, "update", "invalid", "labels must be {add?: string[], remove?: string[], set?: string[]}", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "update", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "update", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "update", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "update", issueId];
    let hasUpdates = false;
    if (body.title) {
      args.push("--title", body.title);
      hasUpdates = true;
    }
    if (body.description != null) {
      args.push("--description", body.description);
      hasUpdates = true;
    }
    if (body.priority != null) {
      args.push("--priority", String(body.priority));
      hasUpdates = true;
    }
    if (body.status) {
      args.push("--status", body.status);
      hasUpdates = true;
    }
    if (body.type) {
      args.push("--type", body.type);
      hasUpdates = true;
    }
    if (body.assignee != null) {
      args.push("--assignee", body.assignee);
      hasUpdates = true;
    }
    for (const label of body.labels?.add ?? []) {
      args.push("--add-label", label);
      hasUpdates = true;
    }
    for (const label of body.labels?.remove ?? []) {
      args.push("--remove-label", label);
      hasUpdates = true;
    }
    for (const label of body.labels?.set ?? []) {
      args.push("--label", label);
      hasUpdates = true;
    }
    if (!hasUpdates) return writeError(c, "update", "invalid", "No update fields provided", 400, { projectId, issueId });

    return await runIssueMutation({ c, projectId, issueId, op: "update", repoPath, args, runBdCommand, readIssue });
  });

  router.post("/projects/:projectId/issues/:issueId/close", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<CloseIssueBody>(c.req.raw);
    if (body === undefined) return writeError(c, "close", "invalid", "Invalid JSON body", 400);
    if (body && body.reason != null && typeof body.reason !== "string") return writeError(c, "close", "invalid", "reason must be string|null", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "close", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "close", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "close", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "close", issueId];
    if (body?.reason) args.push("--reason", body.reason);
    return await runIssueMutation({ c, projectId, issueId, op: "close", repoPath, args, runBdCommand, readIssue });
  });

  router.post("/projects/:projectId/issues/:issueId/reopen", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "reopen", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "reopen", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "reopen", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "reopen", issueId];
    return await runIssueMutation({ c, projectId, issueId, op: "reopen", repoPath, args, runBdCommand, readIssue });
  });

  router.delete("/projects/:projectId/issues/:issueId", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "delete", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "delete", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "delete", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "delete", issueId];
    const startedAt = performance.now();
    try {
      const result = await runBdCommand(repoPath, args, "delete");
      if (result.exitCode !== 0) {
        const metadata: Record<string, unknown> = { projectId, issueId, exitCode: result.exitCode };
        const diagnostic = sanitizeBdDiagnostic(result.stderr || result.stdout);
        if (diagnostic) metadata.diagnostic = diagnostic;
        return writeError(c, "delete", "error", "bd delete failed", 502, metadata, startedAt);
      }
      logWrite("delete", "success", startedAt, { projectId, issueId });
      return c.json({ ok: true, issueId, projectId });
    } catch (error) {
      const metadata: Record<string, unknown> = { projectId, issueId };
      const diagnostic = sanitizeBdDiagnostic(error instanceof Error ? error.message : String(error));
      if (diagnostic) metadata.diagnostic = diagnostic;
      return writeError(c, "delete", "error", "bd delete failed", 502, metadata, startedAt);
    }
  });

  router.post("/projects/:projectId/issues/:issueId/comments", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<CommentIssueBody>(c.req.raw);
    if (!body || !isNonEmptyString(body.text)) return writeError(c, "comment", "invalid", "text is required", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "comment", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "comment", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "comment", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "comment", issueId, body.text];
    return await runIssueMutation({ c, projectId, issueId, op: "comment", repoPath, args, runBdCommand, readIssue });
  });

  router.post("/projects/:projectId/issues/:issueId/notes", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<CommentIssueBody>(c.req.raw);
    if (!body || !isNonEmptyString(body.text)) return writeError(c, "note", "invalid", "text is required", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "note", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "note", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "note", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "note", issueId, body.text];
    return await runIssueMutation({ c, projectId, issueId, op: "note", repoPath, args, runBdCommand, readIssue });
  });

  router.post("/projects/:projectId/issues/:issueId/dependencies", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<AddDependencyBody>(c.req.raw);
    if (!body || !isNonEmptyString(body.dependsOnIssueId)) return writeError(c, "dep-add", "invalid", "dependsOnIssueId is required", 400);
    if (!isSafeCliIdentifier(body.dependsOnIssueId)) return writeError(c, "dep-add", "invalid", "invalid dependsOnIssueId", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "dep-add", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "dep-add", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "dep-add", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "dep", "add", issueId, body.dependsOnIssueId];
    return await runIssueMutation({ c, projectId, issueId, op: "dep-add", repoPath, args, runBdCommand, readIssue });
  });

  router.post("/projects/:projectId/issues/:issueId/priority", async (c) => {
    const authError = assertWriteAllowed(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, xtrmDb);
    if (authError) return c.json({ error: authError }, 403);

    const body = await safeJson<SetPriorityBody>(c.req.raw);
    if (!body || body.priority == null || !isPriority(body.priority)) return writeError(c, "priority", "invalid", "priority must be integer 0-4", 400);

    const projectId = c.req.param("projectId");
    if (!isSafeCliIdentifier(projectId)) return writeError(c, "priority", "invalid", "invalid projectId", 400);
    const issueId = c.req.param("issueId");
    if (!isSafeCliIdentifier(issueId)) return writeError(c, "priority", "invalid", "invalid issueId", 400);
    const repoPath = resolveBeadsProjectRepoPath(xtrmDb, projectId);
    if (!repoPath) return writeError(c, "priority", "not_found", "Project not found", 404, { projectId, issueId });

    const args = ["-C", repoPath, ...MUTATION_PREFIX, "priority", issueId, String(body.priority)];
    return await runIssueMutation({ c, projectId, issueId, op: "priority", repoPath, args, runBdCommand, readIssue });
  });

  return router;
}

async function runIssueMutation({
  c,
  projectId,
  issueId,
  op,
  repoPath,
  args,
  runBdCommand,
  readIssue,
}: {
  c: { json: (body: unknown, status?: number) => Response };
  projectId: string;
  issueId?: string;
  op: string;
  repoPath: string;
  args: string[];
  runBdCommand: BdRunner;
  readIssue: IssueReader;
}): Promise<Response> {
  const startedAt = performance.now();
  try {
    const result = await runBdCommand(repoPath, args, op);
    if (result.exitCode !== 0) {
      const metadata: Record<string, unknown> = { projectId, issueId, exitCode: result.exitCode };
      const diagnostic = sanitizeBdDiagnostic(result.stderr || result.stdout);
      if (diagnostic) metadata.diagnostic = diagnostic;
      return writeError(c, op, "error", `bd ${op} failed`, 502, metadata, startedAt);
    }
    const resolvedIssue = resolveIssueFromBdOutput(result.stdout, projectId, issueId, readIssue);
    if (!resolvedIssue) {
      return writeError(c, op, "error", "Mutation succeeded but no issue payload returned", 502, { projectId, issueId }, startedAt);
    }
    logWrite(op, "success", startedAt, { projectId, issueId: resolvedIssue.id });
    return c.json({ issue: resolvedIssue });
  } catch (error) {
    const metadata: Record<string, unknown> = { projectId, issueId };
    const diagnostic = sanitizeBdDiagnostic(error instanceof Error ? error.message : String(error));
    if (diagnostic) metadata.diagnostic = diagnostic;
    return writeError(c, op, "error", `bd ${op} failed`, 502, metadata, startedAt);
  }
}

function resolveIssueFromBdOutput(stdout: string, projectId: string, issueId: string | undefined, readIssue: IssueReader): BeadIssue | null {
  const parsed = parseJson(stdout);
  const candidate = extractIssue(parsed, projectId);
  if (candidate) return candidate;
  const resolvedIssueId = issueId ?? inferIssueId(parsed);
  if (!resolvedIssueId) return null;
  return readIssue(projectId, resolvedIssueId);
}

function extractIssue(value: unknown, projectId: string): BeadIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = [record.issue, record.bead, record.result, record.data].map((entry) => extractIssue(entry, projectId)).find(Boolean);
  if (nested) return nested;
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.title)) return null;
  return {
    id: record.id,
    title: record.title,
    description: typeof record.description === "string" ? record.description : null,
    notes: typeof record.notes === "string" ? record.notes : null,
    status: typeof record.status === "string" ? record.status : "open",
    priority: typeof record.priority === "number" ? record.priority : 2,
    issue_type: typeof record.issue_type === "string" ? record.issue_type : typeof record.type === "string" ? record.type : "task",
    owner: typeof record.owner === "string" ? record.owner : null,
    assignee: typeof record.assignee === "string" ? record.assignee : undefined,
    created_at: typeof record.created_at === "string" ? record.created_at : new Date().toISOString(),
    created_by: typeof record.created_by === "string" ? record.created_by : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : new Date().toISOString(),
    closed_at: typeof record.closed_at === "string" ? record.closed_at : undefined,
    close_reason: typeof record.close_reason === "string" ? record.close_reason : undefined,
    project_id: typeof record.project_id === "string" ? record.project_id : projectId,
    dependencies: parseDependencies(record.dependencies),
    parent_id: typeof record.parent_id === "string" ? record.parent_id : undefined,
    related_ids: Array.isArray(record.related_ids) ? record.related_ids.filter((item): item is string => typeof item === "string") : [],
    labels: Array.isArray(record.labels) ? record.labels.filter((item): item is string => typeof item === "string") : [],
  } satisfies BeadIssue;
}

function inferIssueId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (isNonEmptyString(record.issue_id)) return record.issue_id;
  if (isNonEmptyString(record.id)) return record.id;
  for (const key of ["issue", "bead", "result", "data"]) {
    const nested = inferIssueId(record[key]);
    if (nested) return nested;
  }
  return null;
}

function createIssueReader(db?: Database | null): IssueReader {
  if (!db) return () => null;
  return (projectId, issueId) => {
    const row = db.query(`
      SELECT issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, closed_at, close_reason, notes, created_at, updated_at
      FROM substrate_issues
      WHERE repo_slug = ? AND issue_id = ?
      LIMIT 1
    `).get(projectId, issueId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.issue_id),
      title: String(row.title ?? ""),
      description: row.body == null ? null : String(row.body),
      notes: row.notes == null ? null : String(row.notes),
      status: String(row.state ?? "open"),
      priority: Number(row.priority ?? 2),
      issue_type: String(row.issue_type ?? "task"),
      owner: row.owner == null ? null : String(row.owner),
      created_at: String(row.created_at ?? new Date().toISOString()),
      created_by: null,
      updated_at: String(row.updated_at ?? new Date().toISOString()),
      closed_at: row.closed_at == null ? undefined : String(row.closed_at),
      close_reason: row.close_reason == null ? undefined : String(row.close_reason),
      project_id: projectId,
      dependencies: readSubstrateDependencies(db, projectId, issueId),
      parent_id: row.parent_id == null ? undefined : String(row.parent_id),
      related_ids: parseStringList(row.related_ids),
      labels: parseStringList(row.labels),
    } satisfies BeadIssue;
  };
}

function defaultRunBdCommand(repoPath: string, command: string[], _op: string): Promise<BdRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BD_BIN, command, { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

function assertWriteAllowed(url: string, host: string, origin: string | null, requestToken: string | null, db?: Database | null): string | null {
  if (!db) return "forbidden";
  return isAllowedConsoleWriteRequest(url, host, origin, requestToken, process.env) ? null : "forbidden";
}

async function safeJson<T>(request: Request): Promise<T | null | undefined> {
  const text = await request.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseDependencies(value: unknown): BeadDependency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BeadDependency[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.dep_issue_id ?? record.to_issue;
    if (typeof id !== "string" || id === "") return [];
    return [{
      id,
      title: typeof record.title === "string" ? record.title : "",
      status: typeof record.status === "string" ? record.status : "open",
      issue_type: typeof record.issue_type === "string" ? record.issue_type : undefined,
      dependency_type: typeof record.dependency_type === "string" ? record.dependency_type : typeof record.relation === "string" ? record.relation : "related",
    }];
  });
}

function readSubstrateDependencies(db: Database, projectId: string, issueId: string): BeadDependency[] {
  try {
    const rows = db.query(`
      SELECT d.dep_issue_id, d.relation, i.title, i.state, i.issue_type
      FROM substrate_dependencies d
      LEFT JOIN substrate_issues i ON i.repo_slug = d.repo_slug AND i.issue_id = d.dep_issue_id
      WHERE d.repo_slug = ? AND d.issue_id = ?
    `).all(projectId, issueId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.dep_issue_id),
      title: row.title == null ? "" : String(row.title),
      status: row.state == null ? "open" : String(row.state),
      issue_type: row.issue_type == null ? undefined : String(row.issue_type),
      dependency_type: row.relation == null ? "related" : String(row.relation),
    }));
  } catch {
    return [];
  }
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isPriority(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeCliIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isSafeCliToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_ENUM_TOKEN_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isLabelPatch(value: UpdateIssueBody["labels"]): value is NonNullable<UpdateIssueBody["labels"]> {
  if (!value || typeof value !== "object") return false;
  return [value.add, value.remove, value.set].every((entry) => entry == null || isStringArray(entry));
}

function sanitizeBdDiagnostic(value: string): string | undefined {
  const collapsed = value.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  const redacted = collapsed.replace(/\b(?:[A-Za-z]:)?[\\/][^\s]+/g, "[path]");
  return redacted.length > MAX_BD_DIAGNOSTIC_LENGTH ? `${redacted.slice(0, MAX_BD_DIAGNOSTIC_LENGTH - 3)}...` : redacted;
}

function writeError(
  c: { json: (body: unknown, status?: number) => Response },
  op: string,
  outcome: WriteOutcome,
  message: string,
  status: number,
  metadata: Record<string, unknown> = {},
  startedAt = performance.now(),
): Response {
  logWrite(op, outcome, startedAt, { ...metadata, error: message });
  return c.json({ error: message }, status);
}

function logWrite(op: string, outcome: WriteOutcome, startedAt: number, metadata: Record<string, unknown>): void {
  emit(makeLogEntry("api", "beads.write", outcome === "success" ? "info" : outcome === "forbidden" || outcome === "invalid" || outcome === "not_found" ? "warn" : "error", undefined, {
    action: op,
    op,
    outcome,
    duration_ms: Math.round(performance.now() - startedAt),
    ...metadata,
  }));
}

export function resolveRepoPathFromBeadsPath(beadsPath: string): string {
  return beadsPath.endsWith("/.beads") ? dirname(beadsPath) : beadsPath;
}
