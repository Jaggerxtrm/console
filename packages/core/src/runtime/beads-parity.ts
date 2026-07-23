import { clearInterval, setInterval } from "node:timers";
import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { BeadsReader } from "../state/beads-reader.ts";
import { DoltClient, doltPoolKey, type DoltConfig } from "../state/dolt-client.ts";
import type { BeadIssue, BeadsProject } from "../types/beads.ts";
import { makeLogEntry, type LogEntry } from "./logs.ts";
import { ProjectScanner } from "./project-scanner.ts";

const PARITY_ISSUE_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 300_000;
const ISSUE_FIELDS = ["id", "title", "status", "priority", "issue_type", "owner", "updated_at", "closed_at"] as const;

type BeadIssueField = (typeof ISSUE_FIELDS)[number];
type IssueDiffEntry = { path: string; live: unknown; shadow: unknown };

export type BeadsParitySummary = {
  started_at: string;
  finished_at: string;
  diff_count: number;
  parity_ok_count: number;
  diffs: IssueDiffEntry[];
};

export type PooledDoltClient = {
  client: DoltClient;
  disconnect: () => void | Promise<void>;
};

export interface BeadsParityOptions {
  intervalMs?: number;
  enabled?: boolean;
  owner?: string;
  emitLog?: (entry: LogEntry) => void;
  scanner?: Pick<ProjectScanner, "scanDirectory">;
  createDoltClient?: (config: DoltConfig) => DoltClient;
}

export function createBeadsParityHarness(xtrmDb: Database | null, options: BeadsParityOptions = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const enabled = options.enabled ?? Boolean(xtrmDb);
  const scanner = options.scanner ?? new ProjectScanner({
    searchPath: process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home"),
    maxDepth: 3,
    excludePatterns: ["node_modules", ".git", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"],
  });
  const createClient = options.createDoltClient ?? ((config: DoltConfig) => new DoltClient(config));
  const clientPool = new Map<string, PooledDoltClient>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let latestSummary: BeadsParitySummary | null = null;
  let parityOkCount = 0;

  async function runOnce(): Promise<BeadsParitySummary> {
    const startedAtMs = Date.now();
    const started_at = new Date(startedAtMs).toISOString();
    const diffs: IssueDiffEntry[] = [];
    const projects = await scanner.scanDirectory() as BeadsProject[];
    for (const project of projects) {
      const live = await readLiveIssues(project, clientPool, createClient);
      compareIssues(project.id, live, readShadowIssues(xtrmDb, project.id), diffs);
    }
    if (diffs.length === 0) parityOkCount += 1;
    const summary: BeadsParitySummary = {
      started_at,
      finished_at: new Date().toISOString(),
      diff_count: diffs.length,
      parity_ok_count: parityOkCount,
      diffs: diffs.slice(0, 50),
    };
    latestSummary = summary;
    options.emitLog?.(makeLogEntry("system", "parity.beads", diffs.length === 0 ? "info" : "warn", undefined, {
      ...(options.owner ? { owner: options.owner } : {}),
      outcome: diffs.length === 0 ? "match" : "diff",
      duration_ms: Date.now() - startedAtMs,
      diff_count: diffs.length,
      parity_ok_count: parityOkCount,
    }));
    return summary;
  }

  function start(): void {
    if (!enabled || timer) return;
    void runOnce();
    timer = setInterval(() => void runOnce(), intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    void Promise.all([...clientPool.values()].map(async ({ disconnect }) => disconnect()))
      .catch(() => undefined)
      .finally(() => clientPool.clear());
  }

  return { start, stop, runOnce, getLatestSummary: () => latestSummary, getParityOkCount: () => parityOkCount };
}

export function getPooledDoltClient(
  clientPool: Map<string, PooledDoltClient>,
  config: DoltConfig,
  createClient: (config: DoltConfig) => DoltClient = (value) => new DoltClient(value),
): DoltClient {
  const key = doltPoolKey(config);
  const existing = clientPool.get(key);
  if (existing) return existing.client;
  const client = createClient(config);
  clientPool.set(key, { client, disconnect: () => client.disconnect() });
  return client;
}

async function readLiveIssues(
  project: BeadsProject,
  clientPool: Map<string, PooledDoltClient>,
  createClient: (config: DoltConfig) => DoltClient,
): Promise<BeadIssue[]> {
  if (project.doltPort) {
    try {
      return await getPooledDoltClient(clientPool, {
        host: process.env.DOLT_HOST ?? "127.0.0.1",
        port: project.doltPort,
        database: project.doltDatabase ?? "dolt",
      }, createClient).getIssues({ limit: PARITY_ISSUE_LIMIT });
    } catch {
      // Preserve JSONL fallback.
    }
  }
  try {
    const content = await readFile(`${project.beadsPath}/issues.jsonl`, "utf-8");
    return content.split("\n").flatMap((line) => BeadsReader.parseIssueLine(line)).map((issue) => ({ ...issue, project_id: project.id }));
  } catch {
    return [];
  }
}

function readShadowIssues(db: Database | null, projectId: string): BeadIssue[] {
  if (!db) return [];
  try {
    const rows = db.query("SELECT issue_id, title, body, state, deleted_at, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(projectId) as Array<Record<string, unknown>>;
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
      dependencies: [],
      related_ids: [],
      labels: [],
    }));
  } catch {
    return [];
  }
}

function compareIssues(projectId: string, live: readonly BeadIssue[], shadow: readonly BeadIssue[], diffs: IssueDiffEntry[]): void {
  const liveMap = new Map(live.map((issue) => [issue.id, issue]));
  const shadowMap = new Map(shadow.map((issue) => [issue.id, issue]));
  for (const [id, issue] of liveMap) {
    const other = shadowMap.get(id);
    if (!other) diffs.push({ path: `${projectId}:${id}`, live: pickIssueFields(issue), shadow: null });
    else if (hasIssueFieldDiff(issue, other)) diffs.push({ path: `${projectId}:${id}`, live: pickIssueFields(issue), shadow: pickIssueFields(other) });
  }
  for (const [id, issue] of shadowMap) {
    if (!liveMap.has(id)) diffs.push({ path: `${projectId}:${id}`, live: null, shadow: pickIssueFields(issue) });
  }
}

function hasIssueFieldDiff(left: BeadIssue, right: BeadIssue): boolean {
  const leftIssue = left as Record<BeadIssueField, unknown>;
  const rightIssue = right as Record<BeadIssueField, unknown>;
  return ISSUE_FIELDS.some((field) => leftIssue[field] !== rightIssue[field]);
}

function pickIssueFields(issue: BeadIssue): Record<BeadIssueField, unknown> {
  return Object.fromEntries(ISSUE_FIELDS.map((field) => [field, (issue as Record<BeadIssueField, unknown>)[field]])) as Record<BeadIssueField, unknown>;
}
