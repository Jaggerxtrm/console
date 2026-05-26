import type { Database } from "bun:sqlite";
import type { AttachPoolLike, EpicRun, SpecialistChain, SpecialistJob } from "./types.js";

type JobQuery = {
  whereSql: string;
  orderSql: string;
  params: readonly string[];
};

const IN_FLIGHT_STATUSES = ["starting", "running", "waiting"] as const;
const HISTORY_STATUSES = ["done", "error", "cancelled"] as const;
const JOB_COLUMNS_BASE = "job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist";
// `last_output` is on every sp schema we ship, but historical observability dbs
// in the wild may pre-date it. Probe per-repo once and cache; fall back to a
// NULL literal in the SELECT if the column is missing so the rest of the join
// still returns the job's metadata. Keyed by repo slug (stable across pool
// recreations) rather than attach-alias (changes every time the 2s-TTL bundle
// rebuilds the pool, which would invalidate the cache).
const slugHasLastOutput = new Map<string, boolean>();
// Same pattern for the metrics table — older observability dbs may not have
// specialist_job_metrics; LEFT JOIN through a missing table would throw.
const slugHasMetrics = new Map<string, boolean>();

export function createObservabilityDao(pool: AttachPoolLike) {
  return {
    jobsByBead: (beadId: string) => sortDesc(readJobs(pool, { whereSql: `WHERE bead_id = ?`, orderSql: ``, params: [beadId] })),
    inFlightJobs: () => sortDesc(readJobs(pool, { whereSql: `WHERE status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(",")})`, orderSql: ``, params: [...IN_FLIGHT_STATUSES] })),
    recentJobs: (limit: number) => sortDesc(readJobs(pool, { whereSql: `WHERE status IN (${HISTORY_STATUSES.map(() => "?").join(",")})`, orderSql: ``, params: [...HISTORY_STATUSES] })).slice(0, limit),
    chainById: (chainId: string) => sortChain(readJobs(pool, { whereSql: `WHERE chain_id = ?`, orderSql: ``, params: [chainId] })) as SpecialistChain[],
    epicById: (epicId: string) => sortAsc(readJobs(pool, { whereSql: `WHERE epic_id = ?`, orderSql: ``, params: [epicId] })) as EpicRun[],
    coverage: () => pool.getCoverage(),
    refreshInFlight: async (limit: number) => {
      const inFlight = await readJobsChunked(pool, { whereSql: `WHERE status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(",")})`, orderSql: ``, params: [...IN_FLIGHT_STATUSES] });
      const recentHistory = (await readJobsChunked(pool, { whereSql: `WHERE status IN (${HISTORY_STATUSES.map(() => "?").join(",")})`, orderSql: ``, params: [...HISTORY_STATUSES] })).slice(0, limit);
      return { in_flight: sortDesc(inFlight), recent_history: sortDesc(recentHistory), jobs: sortDesc(inFlight) };
    },
  };
}

function sortDesc(rows: SpecialistJob[]): SpecialistJob[] {
  return rows.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function sortAsc(rows: SpecialistJob[]): SpecialistJob[] {
  return rows.slice().sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

function chainKindRank(kind: string | null): number {
  if (kind === "executor") return 0;
  if (kind === "reviewer") return 1;
  return 2;
}

function sortChain(rows: SpecialistJob[]): SpecialistJob[] {
  return rows.slice().sort((a, b) => {
    const rank = chainKindRank(a.chainKind) - chainKindRank(b.chainKind);
    if (rank !== 0) return rank;
    return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  });
}

function readJobs(pool: AttachPoolLike, query: JobQuery): SpecialistJob[] {
  return pool.withAttached((db, attached) => {
    if (attached.length === 0) return [];

    const rows = attached.flatMap(({ alias, slug }) => {
      const lastOutputExpr = hasLastOutputColumn(db, alias, slug) ? "j.last_output" : "NULL AS last_output";
      const hasMetrics = hasMetricsTable(db, alias, slug);
      const hasEvents = hasEventsTable(db, alias, slug);
      // metrics row only materializes on terminal status (done/error/cancelled),
      // so for in-flight jobs we fall back to counting events directly.
      const eventsJoin = hasEvents
        ? `LEFT JOIN (
            SELECT job_id,
              COUNT(CASE WHEN type = 'turn' THEN 1 END) AS turn_count,
              COUNT(CASE WHEN type = 'tool' THEN 1 END) AS tool_count
            FROM ${alias}.specialist_events
            GROUP BY job_id
          ) AS e ON e.job_id = j.job_id`
        : "";
      const metricsJoin = hasMetrics
        ? `LEFT JOIN ${alias}.specialist_job_metrics AS m ON m.job_id = j.job_id`
        : "";
      const turnsExpr = hasMetrics && hasEvents
        ? "COALESCE(m.total_turns, e.turn_count) AS m_turns"
        : hasMetrics
          ? "m.total_turns AS m_turns"
          : hasEvents
            ? "e.turn_count AS m_turns"
            : "NULL AS m_turns";
      const toolsExpr = hasMetrics && hasEvents
        ? "COALESCE(m.total_tools, e.tool_count) AS m_tools"
        : hasMetrics
          ? "m.total_tools AS m_tools"
          : hasEvents
            ? "e.tool_count AS m_tools"
            : "NULL AS m_tools";
      const modelExpr = hasMetrics ? "m.model AS m_model" : "NULL AS m_model";
      const baseCols = JOB_COLUMNS_BASE.split(", ").map((col) => `j.${col}`).join(", ");
      const querySql = `
        SELECT '${escapeSql(slug)}' AS repoSlug, ${baseCols}, ${lastOutputExpr}, ${turnsExpr}, ${toolsExpr}, ${modelExpr}
        FROM ${alias}.specialist_jobs AS j
        ${metricsJoin}
        ${eventsJoin}
        ${query.whereSql.replace(/\b(job_id|bead_id|chain_id|epic_id|chain_kind|status|updated_at_ms|specialist)\b/g, "j.$1")}
        ${query.orderSql}
      `;
      return db.prepare(querySql).all(...query.params) as Array<Record<string, unknown>>;
    });

    return rows.map(mapRow);
  });
}

async function readJobsChunked(pool: AttachPoolLike, query: JobQuery): Promise<SpecialistJob[]> {
  const rows: SpecialistJob[] = [];
  await pool.withAttached(async (db, attached) => {
    if (attached.length === 0) return;

    let processed = 0;
    for (const { alias, slug } of attached) {
      const lastOutputExpr = hasLastOutputColumn(db, alias, slug) ? "j.last_output" : "NULL AS last_output";
      const hasMetrics = hasMetricsTable(db, alias, slug);
      const hasEvents = hasEventsTable(db, alias, slug);
      const eventsJoin = hasEvents
        ? `LEFT JOIN (
            SELECT job_id,
              COUNT(CASE WHEN type = 'turn' THEN 1 END) AS turn_count,
              COUNT(CASE WHEN type = 'tool' THEN 1 END) AS tool_count
            FROM ${alias}.specialist_events
            GROUP BY job_id
          ) AS e ON e.job_id = j.job_id`
        : "";
      const metricsJoin = hasMetrics
        ? `LEFT JOIN ${alias}.specialist_job_metrics AS m ON m.job_id = j.job_id`
        : "";
      const turnsExpr = hasMetrics && hasEvents ? "COALESCE(m.total_turns, e.turn_count) AS m_turns" : hasMetrics ? "m.total_turns AS m_turns" : hasEvents ? "e.turn_count AS m_turns" : "NULL AS m_turns";
      const toolsExpr = hasMetrics && hasEvents ? "COALESCE(m.total_tools, e.tool_count) AS m_tools" : hasMetrics ? "m.total_tools AS m_tools" : hasEvents ? "e.tool_count AS m_tools" : "NULL AS m_tools";
      const modelExpr = hasMetrics ? "m.model AS m_model" : "NULL AS m_model";
      const baseCols = JOB_COLUMNS_BASE.split(", ").map((col) => `j.${col}`).join(", ");
      const querySql = `
        SELECT '${escapeSql(slug)}' AS repoSlug, ${baseCols}, ${lastOutputExpr}, ${turnsExpr}, ${toolsExpr}, ${modelExpr}
        FROM ${alias}.specialist_jobs AS j
        ${metricsJoin}
        ${eventsJoin}
        ${query.whereSql.replace(/\b(job_id|bead_id|chain_id|epic_id|chain_kind|status|updated_at_ms|specialist)\b/g, "j.$1")}
        ${query.orderSql}
      `;
      rows.push(...(db.prepare(querySql).all(...query.params) as Array<Record<string, unknown>>).map(mapRow));
      processed += 1;
      if (processed % 5 === 0) await yieldToEventLoop();
    }
  });
  return rows;
}

function hasLastOutputColumn(db: Database, alias: string, slug: string): boolean {
  const cached = slugHasLastOutput.get(slug);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const cols = db.prepare(`PRAGMA ${alias}.table_info(specialist_jobs)`).all() as Array<{ name: string }>;
    present = cols.some((col) => col.name === "last_output");
  } catch {
    present = false;
  }
  slugHasLastOutput.set(slug, present);
  return present;
}

function hasMetricsTable(db: Database, alias: string, slug: string): boolean {
  const cached = slugHasMetrics.get(slug);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    db.prepare(`SELECT 1 FROM ${alias}.specialist_job_metrics LIMIT 0`).run();
    present = true;
  } catch {
    present = false;
  }
  slugHasMetrics.set(slug, present);
  return present;
}

const slugHasEvents = new Map<string, boolean>();
function hasEventsTable(db: Database, alias: string, slug: string): boolean {
  const cached = slugHasEvents.get(slug);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    db.prepare(`SELECT 1 FROM ${alias}.specialist_events LIMIT 0`).run();
    present = true;
  } catch {
    present = false;
  }
  slugHasEvents.set(slug, present);
  return present;
}

function mapRow(row: Record<string, unknown>): SpecialistJob {
  return {
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repoSlug),
    beadId: String(row.bead_id),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: row.m_turns == null ? null : Number(row.m_turns),
    tools: row.m_tools == null ? null : Number(row.m_tools),
    model: row.m_model == null ? null : String(row.m_model),
  };
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
