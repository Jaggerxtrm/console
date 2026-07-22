// Pure SQL query services for the Specialists activity/evidence read model.
// Owns selection, job->bead correlation, token usage, and forensic envelope
// sanitization against the durable `specialist_jobs`, `specialist_job_events`,
// and `xtrm_forensic_events` tables.
//
// Opaque bead_id / job_id / evidence_id strings are preserved verbatim.

import type { Database } from "bun:sqlite";

export interface SpecialistTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  tool: number;
  source: string | null;
}

export interface SpecialistJobRow {
  jobId: string | null;
  repoSlug: string;
  beadId: string;
  chainId: string | null;
  epicId: string | null;
  chainKind: string | null;
  status: string;
  updatedAt: string;
  specialist: string | null;
  lastOutput: string | null;
  turns: number | null;
  tools: number | null;
  model: string | null;
  tokenUsage: SpecialistTokenUsage;
}

export interface SpecialistJobFilter {
  repoSlugs?: readonly string[];
}

export interface ForensicEventPayload {
  schema_version?: string | number;
  timestamp?: string;
  t_unix_ms?: number;
  seq?: number;
  severity?: string;
  event_family?: string;
  event_name?: string;
  event_version?: number;
  resource?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  body?: Record<string, unknown>;
  redaction?: Record<string, unknown>;
  trace?: Record<string, unknown>;
  links?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

export interface MaterializationStateRow {
  source_key: string;
  last_status: string | null;
  last_success_at: string | null;
}

const CANONICAL_ENVELOPE_KEYS = [
  "schema_version",
  "timestamp",
  "t_unix_ms",
  "seq",
  "severity",
  "event_family",
  "event_name",
  "event_version",
  "resource",
  "correlation",
  "body",
  "redaction",
  "trace",
  "links",
  "diagnostics",
] as const;

export function readSpecialistJobsByBead(db: Database | null | undefined, beadId: string, filter?: SpecialistJobFilter): SpecialistJobRow[] {
  if (!db) return [];
  const beadIdExpr = beadIdColumnExpression(db);
  const repoFilter = repoWhere(filter);
  return loadSpecialistJobs(db, `WHERE ${beadIdExpr} = ?${repoFilter.sql}`, [beadId, ...repoFilter.params], beadIdExpr);
}

export function readSpecialistInFlightJobs(db: Database | null | undefined, filter?: SpecialistJobFilter): SpecialistJobRow[] {
  if (!db) return [];
  const beadIdExpr = beadIdColumnExpression(db);
  const repoFilter = repoWhere(filter);
  return loadSpecialistJobs(db, `WHERE j.status IN ('starting', 'running', 'waiting')${repoFilter.sql}`, repoFilter.params, beadIdExpr);
}

export function readSpecialistRecentJobs(db: Database | null | undefined, limit: number, filter?: SpecialistJobFilter): SpecialistJobRow[] {
  if (!db) return [];
  const beadIdExpr = beadIdColumnExpression(db);
  const repoFilter = repoWhere(filter);
  return loadSpecialistJobs(db, `WHERE j.status IN ('done', 'error', 'failed', 'cancelled')${repoFilter.sql}`, repoFilter.params, beadIdExpr, limit);
}

export function readSpecialistChainJobs(db: Database | null | undefined, chainId: string, filter?: SpecialistJobFilter): SpecialistJobRow[] {
  if (!db) return [];
  const beadIdExpr = beadIdColumnExpression(db);
  const repoFilter = repoWhere(filter);
  return loadSpecialistJobs(db, `WHERE (j.chain_id = ? OR (j.chain_id IS NULL AND j.job_id = ?))${repoFilter.sql}`, [chainId, chainId, ...repoFilter.params], beadIdExpr);
}

export function readSpecialistJobResult(db: Database | null | undefined, jobId: string): { text: string; contentType: "text/markdown" } | null {
  if (!db) return null;
  const row = db.query(`
    SELECT payload
    FROM specialist_job_events
    WHERE job_id = ? AND event_type IN ('result', 'terminal_output')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(jobId) as { payload?: string } | undefined;
  if (!row) return null;
  return { text: row.payload ?? "", contentType: "text/markdown" };
}

export function readSpecialistFeedEvents(db: Database | null | undefined, repoSlug: string, jobId: string): ForensicEventPayload[] {
  if (!db) return [];
  if (hasTableColumn(db, "xtrm_forensic_events", "envelope_json")) {
    const rows = db.query(`
      SELECT envelope_json
      FROM xtrm_forensic_events
      WHERE repo_slug = ? AND job_id = ?
      ORDER BY COALESCE(t_unix_ms, 0) ASC, COALESCE(seq, 0) ASC, id ASC
    `).all(repoSlug, jobId) as Array<{ envelope_json?: string }>;
    return rows.flatMap((row) => parseForensicEnvelope(row.envelope_json));
  }
  const rows = db.query(`
    SELECT payload
    FROM specialist_job_events
    WHERE repo_slug = ? AND job_id = ? AND event_type = 'forensic_event'
    ORDER BY created_at ASC
  `).all(repoSlug, jobId) as Array<{ payload?: string }>;
  return rows.flatMap((row) => parseForensicEnvelope(row.payload));
}

export function readMaterializationState(db: Database | null | undefined): MaterializationStateRow[] {
  if (!db) return [];
  return db.query("SELECT source_key, last_status, last_success_at FROM materialization_state").all() as MaterializationStateRow[];
}

function loadSpecialistJobs(
  db: Database,
  whereSql: string,
  params: readonly (string | number)[],
  beadIdExpr = beadIdColumnExpression(db),
  limit?: number,
): SpecialistJobRow[] {
  const limitSql = limit === undefined ? "" : "\n    LIMIT ?";
  const queryParams = limit === undefined ? params : [...params, Math.max(0, Math.floor(limit))];
  const rows = db.query(`
    SELECT j.repo_slug, j.job_id, ${beadIdExpr} AS bead_id, j.chain_id, j.epic_id, j.chain_kind, j.status, j.updated_at, j.specialist, j.last_output,
      ${metricExpr(db, "turns")} AS turns, ${metricExpr(db, "tools")} AS tools, ${metricExpr(db, "model")} AS model,
      ${metricExpr(db, "token_input")} AS token_input, ${metricExpr(db, "token_output")} AS token_output,
      ${metricExpr(db, "token_cache_read")} AS token_cache_read, ${metricExpr(db, "token_cache_creation")} AS token_cache_creation,
      ${metricExpr(db, "token_reasoning")} AS token_reasoning, ${metricExpr(db, "token_tool")} AS token_tool,
      ${metricExpr(db, "usage_source")} AS usage_source
    FROM specialist_jobs AS j
    LEFT JOIN substrate_job_link AS l ON l.repo_slug = j.repo_slug AND l.job_id = j.job_id
    ${whereSql}
    ORDER BY COALESCE(j.updated_at, '') DESC, j.job_id ASC${limitSql}
  `).all(...queryParams) as Array<Record<string, unknown>>;
  return rows.map(mapJobRow);
}

function beadIdColumnExpression(db: Database): string {
  return hasTableColumn(db, "specialist_jobs", "bead_id")
    ? "COALESCE(l.issue_id, j.bead_id, j.job_id)"
    : "COALESCE(l.issue_id, j.job_id)";
}

function metricExpr(db: Database, column: string): string {
  return hasTableColumn(db, "specialist_jobs", column) ? `j.${column}` : "NULL";
}

function hasTableColumn(db: Database, table: string, column: string): boolean {
  const tableRow = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!tableRow) return false;
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

function repoWhere(filter?: SpecialistJobFilter): { sql: string; params: string[] } {
  const repoSlugs = filter?.repoSlugs?.filter(Boolean) ?? [];
  if (repoSlugs.length === 0) return { sql: "", params: [] };
  return { sql: ` AND j.repo_slug IN (${repoSlugs.map(() => "?").join(",")})`, params: [...repoSlugs] };
}

function mapJobRow(row: Record<string, unknown>): SpecialistJobRow {
  return {
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repo_slug),
    beadId: String(row.bead_id),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status),
    updatedAt: String(row.updated_at ?? new Date(0).toISOString()),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: row.turns == null ? null : Number(row.turns),
    tools: row.tools == null ? null : Number(row.tools),
    model: row.model == null ? null : String(row.model),
    tokenUsage: {
      input: Number(row.token_input ?? 0),
      output: Number(row.token_output ?? 0),
      cacheRead: Number(row.token_cache_read ?? 0),
      cacheCreation: Number(row.token_cache_creation ?? 0),
      reasoning: Number(row.token_reasoning ?? 0),
      tool: Number(row.token_tool ?? 0),
      source: row.usage_source == null ? null : String(row.usage_source),
    },
  };
}

function parseForensicEnvelope(payload: string | undefined): ForensicEventPayload[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return [sanitizeForensicEnvelope(parsed as Record<string, unknown>)];
  } catch {
    return [];
  }
}

function sanitizeForensicEnvelope(value: Record<string, unknown>): ForensicEventPayload {
  const out: Record<string, unknown> = {};
  for (const key of CANONICAL_ENVELOPE_KEYS) {
    if (!(key in value)) continue;
    const v = value[key];
    if (v != null) out[key] = v;
  }
  return out as ForensicEventPayload;
}
