/**
 * DoltClient - MySQL client for dolt database connections
 */

import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { BeadIssue, BeadDependency, IssueFilters, BeadIssueDetail } from "../types/beads.ts";
import { emit, makeLogEntry } from "../../../gitboard/src/core/logger.ts";

const POOL_SIZE = 4;
const IDLE_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 5_000;
const BREAKER_THRESHOLD = 5;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 30_000;
const QUERY_TIMEOUT_MS = 3_000;
const LATENCY_RING_SIZE = 100;

export interface DoltConfig {
  host: string;
  port: number;
  user?: string;
  database?: string;
}

type QueryMetric = { latencyMs: number; ok: boolean; at: string };

type DoltRuntimeState = {
  pool: Pool | null;
  poolKey: string;
  connected: boolean;
  probing: boolean;
  lastProbeAt: number;
  consecutiveFailures: number;
  breakerOpenUntil: number;
  reconnectAttempts: number;
  metrics: QueryMetric[];
  probeTimer: ReturnType<typeof setInterval> | null;
};

const runtimes = new Map<string, DoltRuntimeState>();
let lastUsedPoolKey: string | null = null;

function createRuntime(key: string): DoltRuntimeState {
  return {
    pool: null,
    poolKey: key,
    connected: false,
    probing: false,
    lastProbeAt: 0,
    consecutiveFailures: 0,
    breakerOpenUntil: 0,
    reconnectAttempts: 0,
    metrics: [],
    probeTimer: null,
  };
}

function getRuntime(key: string): DoltRuntimeState {
  lastUsedPoolKey = key;
  const existing = runtimes.get(key);
  if (existing) return existing;
  const runtime = createRuntime(key);
  runtimes.set(key, runtime);
  return runtime;
}

export function getDoltHealthSnapshot(poolKeyOverride?: string): { consecutiveFailures: number; breakerOpenUntil: number; latencies: number[] } {
  const key = poolKeyOverride ?? lastUsedPoolKey;
  const runtime = key ? runtimes.get(key) : undefined;
  return {
    consecutiveFailures: runtime?.consecutiveFailures ?? 0,
    breakerOpenUntil: runtime?.breakerOpenUntil ?? 0,
    latencies: runtime?.metrics.map((metric) => metric.latencyMs) ?? [],
  };
}

export function resetDoltRuntimeForTests(): void {
  for (const runtime of runtimes.values()) {
    runtime.probeTimer && clearInterval(runtime.probeTimer);
  }
  runtimes.clear();
  lastUsedPoolKey = null;
}

export function doltPoolKey(config: DoltConfig): string {
  return `${config.host}:${config.port}/${config.database ?? "dolt"}/${config.user ?? "root"}`;
}

function jitter(ms: number): number {
  return Math.floor(ms * (0.8 + Math.random() * 0.4));
}

function backoffDelay(attempt: number): number {
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  return jitter(delay);
}

function rememberMetric(runtime: DoltRuntimeState, latencyMs: number, ok: boolean): void {
  runtime.metrics.push({ latencyMs, ok, at: new Date().toISOString() });
  if (runtime.metrics.length > LATENCY_RING_SIZE) runtime.metrics.splice(0, runtime.metrics.length - LATENCY_RING_SIZE);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return await new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Dolt query timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

export class DoltClient {
  private config: DoltConfig;

  constructor(config: DoltConfig) {
    this.config = {
      database: "dolt",
      ...config,
      user: config.user ?? "root",
    };
  }

  private get poolKey(): string {
    return doltPoolKey(this.config);
  }

  private get runtime(): DoltRuntimeState {
    return getRuntime(this.poolKey);
  }

  private get connected(): boolean {
    const runtime = this.runtime;
    return runtime.connected && runtime.pool !== null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    emit(makeLogEntry("dolt", "reconnect.attempt", "info", undefined, { host: this.config.host, port: this.config.port }));
    await this.ensurePool();
  }

  async disconnect(): Promise<void> {
    const runtime = this.runtime;
    if (!this.connected || !runtime.pool) return;
    await runtime.pool.end();
    runtime.pool = null;
    runtime.connected = false;
    runtime.probeTimer && clearInterval(runtime.probeTimer);
    runtime.probeTimer = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isBreakerOpen(): boolean {
    return Date.now() < this.runtime.breakerOpenUntil;
  }

  async getIssues(filters: IssueFilters = {}): Promise<BeadIssue[]> {
    const rows = await this.selectIssues(filters);
    return this.hydrateIssues(rows);
  }

  async getCommitHash(): Promise<string> {
    const [rows] = await this.execute<RowDataPacket[]>("SELECT current_commit() AS commit_hash");
    const row = rows[0] as RowDataPacket | undefined;
    return String(row?.commit_hash ?? row?.hash ?? row?.commit ?? "");
  }

  async getIssuesSince(updatedSince: string): Promise<BeadIssue[]> {
    const issues = await this.getIssues({ limit: 1000, offset: 0, search: undefined });
    return issues.filter((issue) => issue.updated_at > updatedSince);
  }

  async getIssue(issueId: string): Promise<BeadIssueDetail | null> {
    const [row] = await this.selectIssues({ limit: 1, offset: 0 }, issueId);
    if (!row) return null;

    const issue = await this.toIssue(row);
    const dependents = await this.getDependents(issueId);
    return {
      ...issue,
      dependents,
      children: dependents.filter((dependency) => dependency.dependency_type === "parent-child"),
      source: "dolt",
      sourceHealth: [{ kind: "dolt", state: "available" }],
    };
  }

  async fetchIssuesSince(updatedSince: string): Promise<BeadIssue[]> {
    return await this.getIssuesSince(updatedSince);
  }

  async getClosedIssues(limit: number = 50): Promise<BeadIssue[]> {
    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT * FROM issues WHERE status = 'closed' AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT ?`,
      [limit],
    );
    return this.hydrateIssues(rows);
  }

  async getStats(): Promise<{ total: number; open: number; in_progress: number; blocked: number; closed: number }> {
    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
       FROM issues`,
    );
    const row = rows[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      open: Number(row.open ?? 0),
      in_progress: Number(row.in_progress ?? 0),
      blocked: Number(row.blocked ?? 0),
      closed: Number(row.closed ?? 0),
    };
  }

  async probeHealth(): Promise<boolean> {
    const runtime = this.runtime;
    try {
      await this.execute<RowDataPacket[]>("SELECT 1 AS ok");
      runtime.consecutiveFailures = 0;
      runtime.breakerOpenUntil = 0;
      return true;
    } catch {
      return false;
    }
  }

  private async ensurePool(): Promise<Pool> {
    const runtime = this.runtime;
    if (runtime.pool) return runtime.pool;

    runtime.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      database: this.config.database,
      connectionLimit: POOL_SIZE,
      maxIdle: POOL_SIZE,
      idleTimeout: IDLE_TIMEOUT_MS,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
    runtime.connected = true;
    emit(makeLogEntry("dolt", "reconnect.recovered", "info", undefined, { host: this.config.host, port: this.config.port, poolKey: runtime.poolKey }));
    this.ensureProbeLoop();
    return runtime.pool;
  }

  private ensureProbeLoop(): void {
    const runtime = this.runtime;
    if (runtime.probeTimer) return;
    runtime.probeTimer = setInterval(() => {
      void this.runProbe();
    }, PROBE_INTERVAL_MS);
    if (typeof runtime.probeTimer.unref === "function") runtime.probeTimer.unref();
  }

  private async runProbe(): Promise<void> {
    const runtime = this.runtime;
    if (runtime.probing || !runtime.pool) return;
    if (Date.now() < runtime.breakerOpenUntil) return;
    runtime.probing = true;
    runtime.lastProbeAt = Date.now();
    try {
      await this.execute<RowDataPacket[]>("SELECT 1 AS ok");
      runtime.consecutiveFailures = 0;
      runtime.breakerOpenUntil = 0;
      runtime.reconnectAttempts = 0;
    } catch {
      this.recordFailure();
    } finally {
      runtime.probing = false;
    }
  }

  private recordFailure(): void {
    const runtime = this.runtime;
    runtime.consecutiveFailures += 1;
    rememberMetric(runtime, QUERY_TIMEOUT_MS, false);
    if (runtime.consecutiveFailures >= BREAKER_THRESHOLD) {
      runtime.breakerOpenUntil = Date.now() + backoffDelay(runtime.consecutiveFailures);
      runtime.reconnectAttempts = Math.max(runtime.reconnectAttempts, runtime.consecutiveFailures - BREAKER_THRESHOLD + 1);
      emit(makeLogEntry("breaker", "breaker.opened", "warn", undefined, { consecutiveFailures: runtime.consecutiveFailures, breakerOpenUntil: runtime.breakerOpenUntil, poolKey: runtime.poolKey }));
    }
  }

  private async execute<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    const runtime = this.runtime;
    if (Date.now() < runtime.breakerOpenUntil) {
      throw new Error("Dolt circuit breaker open");
    }

    const pool = await this.ensurePool();
    const startedAt = performance.now();
    try {
      const result = await withTimeout(pool.execute<T>(sql, params as any[]), QUERY_TIMEOUT_MS);
      const latency = performance.now() - startedAt;
      rememberMetric(runtime, latency, true);
      if (latency > 100) emit(makeLogEntry("dolt", "query.slow", "warn", undefined, { latencyMs: latency, poolKey: runtime.poolKey }));
      runtime.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.recordFailure();
      if ((error as { fatal?: boolean }).fatal) {
        runtime.connected = false;
        runtime.pool = null;
      }
      throw error;
    }
  }

  private async selectIssues(filters: IssueFilters, issueId?: string): Promise<RowDataPacket[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (issueId) {
      conditions.push("id = ?");
      params.push(issueId);
    }
    if (filters.status?.length) {
      conditions.push(`status IN (${filters.status.map(() => "?").join(", ")})`);
      params.push(...filters.status);
    }
    if (filters.priority?.length) {
      conditions.push(`priority IN (${filters.priority.map(() => "?").join(", ")})`);
      params.push(...filters.priority);
    }
    if (filters.issue_type?.length) {
      conditions.push(`issue_type IN (${filters.issue_type.map(() => "?").join(", ")})`);
      params.push(...filters.issue_type);
    }
    if (filters.search) {
      conditions.push("(title LIKE ? OR description LIKE ?)");
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT * FROM issues ${where} ORDER BY priority ASC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows;
  }

  private async toIssue(row: RowDataPacket): Promise<BeadIssue> {
    const id = String(row.id);
    const [deps, related, labels] = await Promise.all([
      this.getDependencies(id),
      this.getRelatedIds(id),
      this.getLabels(id),
    ]);
    return this.assembleIssue(row, deps, related, labels);
  }

  // Batched hydration: 1 SELECT issues + 3 IN-clause fan-out queries = 4 total,
  // replacing the prior 1 + (3 * rows.length) N+1 pattern.
  private async hydrateIssues(rows: RowDataPacket[]): Promise<BeadIssue[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const [depsByOwner, relatedByOwner, labelsByOwner] = await Promise.all([
      this.getDependenciesByIssueIds(ids),
      this.getRelatedIdsByIssueIds(ids),
      this.getLabelsByIssueIds(ids),
    ]);
    return rows.map((row) => {
      const id = String(row.id);
      return this.assembleIssue(row, depsByOwner.get(id) ?? [], relatedByOwner.get(id) ?? [], labelsByOwner.get(id) ?? []);
    });
  }

  private assembleIssue(row: RowDataPacket, deps: BeadDependency[], related: string[], labels: string[]): BeadIssue {
    return {
      id: String(row.id),
      title: String(row.title ?? ""),
      description: row.description ?? null,
      notes: row.notes ?? null,
      status: String(row.status ?? "open") as BeadIssue["status"],
      priority: Number(row.priority ?? 2) as BeadIssue["priority"],
      issue_type: String(row.issue_type ?? "task") as BeadIssue["issue_type"],
      owner: row.owner ?? null,
      created_at: String(row.created_at ?? ""),
      created_by: row.created_by ?? null,
      updated_at: String(row.updated_at ?? row.created_at ?? ""),
      closed_at: row.closed_at ?? undefined,
      close_reason: row.close_reason ?? undefined,
      project_id: "",
      dependencies: deps,
      parent_id: row.parent_id ?? undefined,
      related_ids: related,
      labels: labels,
    };
  }

  private async getDependenciesByIssueIds(ids: string[]): Promise<Map<string, BeadDependency[]>> {
    const map = new Map<string, BeadDependency[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT d.issue_id AS owner_id, d.depends_on_id AS id, d.type AS dependency_type, i.title, i.status
       FROM dependencies d JOIN issues i ON d.depends_on_id = i.id
       WHERE d.issue_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows as RowDataPacket[]) {
      const ownerId = String(row.owner_id);
      if (!map.has(ownerId)) map.set(ownerId, []);
      map.get(ownerId)!.push({
        id: String(row.id),
        title: String(row.title ?? ""),
        status: String(row.status ?? "open") as BeadDependency["status"],
        dependency_type: String(row.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
      });
    }
    return map;
  }

  private async getRelatedIdsByIssueIds(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    try {
      const [rows] = await this.execute<RowDataPacket[]>(
        `SELECT issue_id, related_issue_id FROM issue_related WHERE issue_id IN (${placeholders})`,
        ids,
      );
      for (const row of rows as RowDataPacket[]) {
        const ownerId = String(row.issue_id);
        const value = String(row.related_issue_id);
        if (!value) continue;
        if (!map.has(ownerId)) map.set(ownerId, []);
        map.get(ownerId)!.push(value);
      }
    } catch {
      // issue_related is optional; swallow as in the single-issue path
    }
    return map;
  }

  private async getLabelsByIssueIds(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    try {
      const [rows] = await this.execute<RowDataPacket[]>(
        `SELECT issue_id, label FROM labels WHERE issue_id IN (${placeholders})`,
        ids,
      );
      for (const row of rows as RowDataPacket[]) {
        const ownerId = String(row.issue_id);
        const value = String(row.label);
        if (!value) continue;
        if (!map.has(ownerId)) map.set(ownerId, []);
        map.get(ownerId)!.push(value);
      }
    } catch {
      // labels is optional
    }
    return map;
  }

  private async getDependencies(issueId: string): Promise<BeadDependency[]> {
    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT d.depends_on_id as id, d.type as dependency_type, i.title, i.status FROM dependencies d JOIN issues i ON d.depends_on_id = i.id WHERE d.issue_id = ?`,
      [issueId],
    );
    return (rows as RowDataPacket[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
    }));
  }

  private async getDependents(issueId: string): Promise<BeadDependency[]> {
    const [rows] = await this.execute<RowDataPacket[]>(
      `SELECT d.issue_id as id, d.type as dependency_type, i.title, i.status FROM dependencies d JOIN issues i ON d.issue_id = i.id WHERE d.depends_on_id = ?`,
      [issueId],
    );
    return (rows as RowDataPacket[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocked_by") as BeadDependency["dependency_type"],
    }));
  }

  private async getRelatedIds(issueId: string): Promise<string[]> {
    try {
      const [rows] = await this.execute<RowDataPacket[]>("SELECT related_issue_id FROM issue_related WHERE issue_id = ?", [issueId]);
      return (rows as RowDataPacket[]).map((row) => String(row.related_issue_id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async getLabels(issueId: string): Promise<string[]> {
    try {
      const [rows] = await this.execute<RowDataPacket[]>("SELECT label FROM labels WHERE issue_id = ?", [issueId]);
      return (rows as RowDataPacket[]).map((row) => String(row.label)).filter(Boolean);
    } catch {
      return [];
    }
  }
}
