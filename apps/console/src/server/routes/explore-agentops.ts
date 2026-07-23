import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";

export type ExploreAgentopsRange = "7d" | "30d" | "all";

export interface ExploreAgentopsFilters {
  range: ExploreAgentopsRange;
  repoSlug: string | null;
  specialist: string | null;
  model: string | null;
  status: string | null;
}

export interface ExploreAgentopsOptions {
  now?: number;
  emit?: (entry: LogEntry) => void;
}

type SourceHealth = {
  source: "explore-agentops";
  status: "fresh" | "degraded";
  metadata: Record<string, unknown>;
};

type JobRow = {
  repo_slug: string;
  job_id: string;
  bead_id: string | null;
  specialist: string | null;
  status: string;
  model: string | null;
  turns: number | null;
  tools: number | null;
  token_input: number | null;
  token_output: number | null;
  token_cache_read: number | null;
  token_cache_creation: number | null;
  token_reasoning: number | null;
  token_tool: number | null;
  created_at: string | null;
  updated_at_ms: number | null;
};

type SqlParam = string | number | null;

export function createExploreAgentopsRouter(db: Database | null | undefined, options: ExploreAgentopsOptions = {}): Hono {
  const router = new Hono();
  const log = options.emit ?? (() => {});

  router.get("/agentops", (c) => {
    const startedAt = performance.now();
    const filters = parseFilters(c.req.query(), options.now ?? Date.now());

    if (!db) {
      const empty = buildEmptyResponse(filters, { source: "explore-agentops", status: "degraded", metadata: { reason: "database_unavailable" } });
      logAgentops(log, "degraded", startedAt, filters, 0);
      return c.json(empty);
    }

    try {
      if (!hasTable(db, "specialist_jobs")) {
        const empty = buildEmptyResponse(filters, { source: "explore-agentops", status: "degraded", metadata: { reason: "specialist_jobs_missing" } });
        logAgentops(log, "degraded", startedAt, filters, 0);
        return c.json(empty);
      }

      const rangeWhere = rangeClause(filters, options.now ?? Date.now());
      const facetRows = loadRows(db, rangeWhere.sql, rangeWhere.params);
      const filteredWhere = filterClause(filters, rangeWhere);
      const rows = loadRows(db, filteredWhere.sql, filteredWhere.params);
      const response = buildResponse(filters, rows, facetRows, { source: "explore-agentops", status: "fresh", metadata: {} });
      logAgentops(log, "ok", startedAt, filters, rows.length);
      return c.json(response);
    } catch (error) {
      log(makeLogEntry("explore", "agentops_request", "warn", "agentops query failed", {
        outcome: "error",
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        error: error instanceof Error ? error.message : String(error),
      }));
      return c.json(buildEmptyResponse(filters, { source: "explore-agentops", status: "degraded", metadata: { reason: "query_failed" } }));
    }
  });

  return router;
}

function parseFilters(query: Record<string, string>, now: number): ExploreAgentopsFilters {
  return {
    range: query.range === "30d" || query.range === "all" ? query.range : "7d",
    repoSlug: clean(query.repo_slug),
    specialist: clean(query.specialist),
    model: clean(query.model),
    status: clean(query.status),
  };
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rangeClause(filters: ExploreAgentopsFilters, now: number): { sql: string; params: SqlParam[] } {
  if (filters.range === "all") return { sql: "", params: [] };
  const days = filters.range === "30d" ? 30 : 7;
  return { sql: "WHERE COALESCE(updated_at_ms, 0) >= ?", params: [now - days * 86_400_000] };
}

function filterClause(filters: ExploreAgentopsFilters, base: { sql: string; params: SqlParam[] }): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params = [...base.params];
  if (filters.repoSlug) {
    clauses.push("repo_slug = ?");
    params.push(filters.repoSlug);
  }
  if (filters.specialist) {
    clauses.push("specialist = ?");
    params.push(filters.specialist);
  }
  if (filters.model) {
    clauses.push("COALESCE(model, 'unknown') = ?");
    params.push(filters.model);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  const where = [base.sql.replace(/^WHERE\s+/, ""), ...clauses].filter(Boolean);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function loadRows(db: Database, whereSql: string, params: SqlParam[]): JobRow[] {
  return db.query(`
    SELECT
      repo_slug, job_id, bead_id, specialist, status, model, turns, tools,
      token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool,
      created_at, updated_at_ms
    FROM specialist_jobs
    ${whereSql}
    ORDER BY COALESCE(updated_at_ms, 0) DESC
    LIMIT 5000
  `).all(...params) as JobRow[];
}

function buildResponse(filters: ExploreAgentopsFilters, rows: JobRow[], facetRows: JobRow[], sourceHealth: SourceHealth) {
  return {
    filters,
    summary: summarize(rows),
    facets: {
      repoSlugs: facet(facetRows, (row) => row.repo_slug),
      specialists: facet(facetRows, (row) => row.specialist ?? "unknown"),
      models: facet(facetRows, (row) => row.model ?? "unknown"),
      statuses: facet(facetRows, (row) => row.status),
    },
    statusBreakdown: facet(rows, (row) => row.status).map((item) => ({ status: item.value, count: item.count })),
    specialistLeaderboard: leaderboard(rows, (row) => row.specialist ?? "unknown", "specialist"),
    modelLeaderboard: leaderboard(rows, (row) => row.model ?? "unknown", "model"),
    recentJobs: rows.slice(0, 20).map(toJob),
    slowestJobs: [...rows].sort((a, b) => jobWeight(b) - jobWeight(a)).slice(0, 20).map(toJob),
    source_health: sourceHealth,
  };
}

function buildEmptyResponse(filters: ExploreAgentopsFilters, sourceHealth: SourceHealth) {
  return buildResponse(filters, [], [], sourceHealth);
}

function summarize(rows: JobRow[]) {
  return rows.reduce((acc, row) => {
    const status = row.status;
    acc.totalJobs += 1;
    if (["starting", "running", "waiting"].includes(status)) acc.activeJobs += 1;
    if (status === "done") acc.doneJobs += 1;
    if (status === "error" || status === "failed") acc.errorJobs += 1;
    acc.tokenTotal += tokenTotal(row);
    acc.turnsTotal += Number(row.turns ?? 0);
    acc.toolsTotal += Number(row.tools ?? 0);
    return acc;
  }, { totalJobs: 0, activeJobs: 0, doneJobs: 0, errorJobs: 0, tokenTotal: 0, turnsTotal: 0, toolsTotal: 0 });
}

function facet<T extends string>(rows: JobRow[], valueOf: (row: JobRow) => T): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const row of rows) counts.set(valueOf(row), (counts.get(valueOf(row)) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function leaderboard<TName extends "specialist" | "model">(rows: JobRow[], keyOf: (row: JobRow) => string, keyName: TName): Array<Record<TName, string> & { jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number }> {
  const map = new Map<string, { jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = map.get(key) ?? { jobs: 0, tokenTotal: 0, turnsTotal: 0, toolsTotal: 0 };
    map.set(key, {
      jobs: current.jobs + 1,
      tokenTotal: current.tokenTotal + tokenTotal(row),
      turnsTotal: current.turnsTotal + Number(row.turns ?? 0),
      toolsTotal: current.toolsTotal + Number(row.tools ?? 0),
    });
  }
  return [...map.entries()]
    .map(([key, value]) => ({ [keyName]: key, ...value }) as Record<TName, string> & { jobs: number; tokenTotal: number; turnsTotal: number; toolsTotal: number })
    .sort((a, b) => b.tokenTotal - a.tokenTotal || b.jobs - a.jobs)
    .slice(0, 20);
}

function toJob(row: JobRow) {
  return {
    jobId: row.job_id,
    beadId: row.bead_id ?? "",
    repoSlug: row.repo_slug,
    specialist: row.specialist ?? "unknown",
    status: row.status,
    model: row.model ?? "unknown",
    updatedAtMs: Number(row.updated_at_ms ?? 0),
    elapsedMs: elapsedMs(row),
    tokenTotal: tokenTotal(row),
    turns: Number(row.turns ?? 0),
    tools: Number(row.tools ?? 0),
  };
}

function tokenTotal(row: JobRow): number {
  return Number(row.token_input ?? 0)
    + Number(row.token_output ?? 0)
    + Number(row.token_cache_read ?? 0)
    + Number(row.token_cache_creation ?? 0)
    + Number(row.token_reasoning ?? 0)
    + Number(row.token_tool ?? 0);
}

function elapsedMs(row: JobRow): number {
  const created = row.created_at ? Date.parse(row.created_at) : Number.NaN;
  const updated = Number(row.updated_at_ms ?? 0);
  if (Number.isFinite(created) && updated > created) return updated - created;
  return 0;
}

function jobWeight(row: JobRow): number {
  return elapsedMs(row) || tokenTotal(row) || Number(row.turns ?? 0) + Number(row.tools ?? 0);
}

function hasTable(db: Database, tableName: string): boolean {
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name?: string } | null;
  return row?.name === tableName;
}

function logAgentops(log: (entry: LogEntry) => void, outcome: "ok" | "degraded", startedAt: number, filters: ExploreAgentopsFilters, totalJobs: number): void {
  log(makeLogEntry("explore", "agentops_request", outcome === "ok" ? "info" : "warn", undefined, {
    outcome,
    duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    range: filters.range,
    has_repo_filter: Boolean(filters.repoSlug),
    has_specialist_filter: Boolean(filters.specialist),
    has_model_filter: Boolean(filters.model),
    has_status_filter: Boolean(filters.status),
    total_jobs: totalJobs,
  }));
}
