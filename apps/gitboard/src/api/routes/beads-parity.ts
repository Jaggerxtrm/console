import { clearInterval, setInterval } from "node:timers";
import type { Database } from "bun:sqlite";
import { ProjectScanner } from "../../../../beadboard/src/core/project-scanner.ts";
import { BeadsReader } from "../../../../beadboard/src/core/beads-reader.ts";
import { DoltClient, doltPoolKey } from "../../../../beadboard/src/core/dolt-client.ts";
import type { BeadIssue } from "../../../../beadboard/src/types/beads.ts";

type ParityProject = {
  id: string;
  beadsPath: string;
  doltPort?: number;
  doltDatabase?: string;
};

type PooledDoltClient = {
  client: DoltClient;
  disconnect: () => void | Promise<void>;
};

const PARITY_ISSUE_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 300_000;

/**
 * forge-eorh.55 contract NOTES: parity diff stays narrow on purpose.
 * Tracked fields: id, title, status, priority, issue_type, owner, updated_at, closed_at.
 * Excluded BeadIssue fields: description, notes, assignee, created_by, dependencies, related_ids, labels, parent_id.
 * Reason: full-object compare floods noise from drift-only fields and caused OOM-grade churn in forge-eorh.47.
 */
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

export function createBeadsParityHarness(xtrmDb: Database | null, options: { intervalMs?: number; enabled?: boolean } = {}): {
  start(): void;
  stop(): void;
  runOnce(): Promise<BeadsParitySummary>;
  getLatestSummary(): BeadsParitySummary | null;
  getParityOkCount(): number;
} {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const enabled = options.enabled ?? Boolean(xtrmDb);
  const scanner = new ProjectScanner({
    searchPath: process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home"),
    maxDepth: 3,
    excludePatterns: ["node_modules", ".git", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"],
  });
  const clientPool = new Map<string, PooledDoltClient>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let latestSummary: BeadsParitySummary | null = null;
  let parityOkCount = 0;

  async function runOnce(): Promise<BeadsParitySummary> {
    const started_at = new Date().toISOString();
    const diffs: IssueDiffEntry[] = [];
    const projects = await scanner.scanDirectory() as ParityProject[];
    for (const project of projects) {
      const live = await readLiveIssues(project, clientPool);
      const shadow = readShadowIssues(xtrmDb, project.id);
      compareIssues(project.id, live, shadow, diffs);
    }
    const summary: BeadsParitySummary = { started_at, finished_at: new Date().toISOString(), diff_count: diffs.length, parity_ok_count: parityOkCount + (diffs.length === 0 ? 1 : 0), diffs: diffs.slice(0, 50) };
    if (diffs.length === 0) parityOkCount += 1;
    latestSummary = summary;
    return summary;
  }

  function start(): void {
    if (!enabled || timer) return;
    void runOnce();
    timer = setInterval(() => { void runOnce(); }, intervalMs);
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

async function readLiveIssues(project: ParityProject, clientPool: Map<string, PooledDoltClient>): Promise<BeadIssue[]> {
  if (project.doltPort) {
    try {
      const client = __testOnly_getPooledDoltClient(clientPool, {
        host: process.env.DOLT_HOST ?? "127.0.0.1",
        port: project.doltPort,
        database: project.doltDatabase ?? "dolt",
      });
      return await client.getIssues({ limit: PARITY_ISSUE_LIMIT });
    } catch {
      // fall through
    }
  }
  try {
    const content = await Bun.file(`${project.beadsPath}/issues.jsonl`).text();
    return content.split("\n").flatMap((line) => BeadsReader.parseIssueLine(line)).map((issue) => ({ ...issue, project_id: project.id }));
  } catch {
    return [];
  }
}

export function __testOnly_getPooledDoltClient(clientPool: Map<string, PooledDoltClient>, config: { host: string; port: number; database: string }): DoltClient {
  const poolKey = doltPoolKey(config);
  const pooled = clientPool.get(poolKey);
  if (pooled) return pooled.client;
  const client = new DoltClient(config);
  clientPool.set(poolKey, { client, disconnect: () => { void client.disconnect(); } });
  return client;
}

function readShadowIssues(db: Database | null, projectId: string): BeadIssue[] {
  if (!db) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.query("SELECT issue_id, title, body, state, deleted_at, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(projectId) as Array<Record<string, unknown>>;
  } catch {
    return [];
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
    dependencies: [],
    related_ids: [],
    labels: [],
  }));
}

function compareIssues(projectId: string, live: readonly BeadIssue[], shadow: readonly BeadIssue[], diffs: IssueDiffEntry[]): void {
  const liveMap = new Map(live.map((issue) => [issue.id, issue]));
  const shadowMap = new Map(shadow.map((issue) => [issue.id, issue]));
  for (const [id, issue] of liveMap) {
    const other = shadowMap.get(id);
    if (!other) {
      diffs.push({ path: `${projectId}:${id}`, live: pickIssueFields(issue), shadow: null });
      continue;
    }
    if (hasIssueFieldDiff(issue, other)) diffs.push({ path: `${projectId}:${id}`, live: pickIssueFields(issue), shadow: pickIssueFields(other) });
  }
  for (const [id, issue] of shadowMap) if (!liveMap.has(id)) diffs.push({ path: `${projectId}:${id}`, live: null, shadow: pickIssueFields(issue) });
}

function hasIssueFieldDiff(left: BeadIssue, right: BeadIssue): boolean {
  const leftIssue = left as Record<BeadIssueField, unknown>;
  const rightIssue = right as Record<BeadIssueField, unknown>;
  return ISSUE_FIELDS.some((field) => leftIssue[field] !== rightIssue[field]);
}

function pickIssueFields(issue: BeadIssue): Record<BeadIssueField, unknown> {
  const issueFields = issue as Record<BeadIssueField, unknown>;
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

