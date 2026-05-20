import type { Database } from "bun:sqlite";
import type { AttachPoolLike, EpicRun, SpecialistChain, SpecialistJob } from "./types.js";

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

export function createObservabilityDao(pool: AttachPoolLike) {
  return {
    jobsByBead: (beadId: string) => sortDesc(readJobs(pool, `WHERE bead_id = ?`, ``, [beadId])),
    inFlightJobs: () => sortDesc(readJobs(pool, `WHERE status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(",")})`, ``, [...IN_FLIGHT_STATUSES])),
    recentJobs: (limit: number) => sortDesc(readJobs(pool, `WHERE status IN (${HISTORY_STATUSES.map(() => "?").join(",")})`, ``, [...HISTORY_STATUSES])).slice(0, limit),
    chainById: (chainId: string) => sortChain(readJobs(pool, `WHERE chain_id = ?`, ``, [chainId])) as SpecialistChain[],
    epicById: (epicId: string) => sortAsc(readJobs(pool, `WHERE epic_id = ?`, ``, [epicId])) as EpicRun[],
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

function readJobs(pool: AttachPoolLike, whereSql: string, orderSql: string, params: readonly string[]): SpecialistJob[] {
  return pool.withAttached((db, attached) => {
    if (attached.length === 0) return [];

    const rows = attached.flatMap(({ alias, slug }) => {
      const lastOutputExpr = hasLastOutputColumn(db, alias, slug) ? "last_output" : "NULL AS last_output";
      const query = `SELECT '${escapeSql(slug)}' AS repoSlug, ${JOB_COLUMNS_BASE}, ${lastOutputExpr} FROM ${alias}.specialist_jobs ${whereSql} ${orderSql}`;
      return db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    });

    return rows.map(mapRow);
  });
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
  };
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
