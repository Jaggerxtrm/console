import { Database } from "bun:sqlite";
import type { MaterializedEvidenceRef, MaterializedForensicEvent, MaterializedSpecialistJob, MaterializerAdapter, MaterializerDelta, MaterializerSnapshot } from "./types.ts";

export const FORENSIC_BATCH_SIZE = 500;
// Job cardinality bound per run. Jobs page via a stable (updated_at_ms, job_id)
// tuple so rows sharing a timestamp cannot be dropped between batches.
export const JOB_BATCH_SIZE = 500;
// Source TEXT byte caps applied in SQL via length()/CASE so oversized payloads
// are never materialized into JS merely to be rejected.
export const LAST_OUTPUT_MAX_BYTES = 64 * 1024;
export const TOKEN_TRAJECTORY_MAX_BYTES = 256 * 1024;
export const EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
// Evidence ref expansion caps: deterministic per-event and per-run ceilings.
export const EVIDENCE_REFS_PER_EVENT_CAP = 64;
export const EVIDENCE_REFS_PER_RUN_CAP = 1024;
// Bound the persisted job_id tie-break so an attacker cannot inject an
// arbitrarily large cursor string into SQL comparisons.
export const JOB_ID_MAX_LEN = 256;

type ObservabilityCursor = {
  updated_at_ms: number;
  job_id: string;
  event_rowid: number;
  forensic_rowid: number;
};

type JobRow = MaterializedSpecialistJob;

type SourceEventRow = {
  rowid: number;
  job_id: string | null;
  seq: number | null;
  t_unix_ms: number | null;
  event_type: string | null;
  payload: string | null;
  payload_bytes: number;
  source: "forensic" | "legacy";
};

type TokenTotals = {
  token_input: number;
  token_output: number;
  token_cache_read: number;
  token_cache_creation: number;
  token_reasoning: number;
  token_tool: number;
};

export function createObservabilityAdapter(dbPath: string, repoSlug: string): MaterializerAdapter<JobRow> {
  const db = new Database(dbPath);
  const beadIdSelect = hasColumn(db, "specialist_jobs", "bead_id") ? "j.bead_id AS bead_id" : "NULL AS bead_id";
  const hasMetrics = hasTable(db, "specialist_job_metrics");
  const hasForensic = hasTable(db, "specialist_forensic_events");
  return {
    async cursor() {
      return { updated_at_ms: 0, job_id: "", event_rowid: 0, forensic_rowid: 0 };
    },
    async changesSince(cursor) {
      const baseline = normalizeCursor(cursor, sourceHighWater(db, hasForensic));
      const recentJobs = readJobsSince(db, repoSlug, baseline, beadIdSelect, hasMetrics);
      const jobsOverflow = recentJobs.length > JOB_BATCH_SIZE;
      const pageJobs = jobsOverflow ? recentJobs.slice(0, JOB_BATCH_SIZE) : recentJobs;
      const eventRows = hasForensic
        ? readForensicEventsSince(db, baseline.forensic_rowid, FORENSIC_BATCH_SIZE)
        : readLegacyEventsSince(db, baseline.event_rowid, FORENSIC_BATCH_SIZE);
      const eventsOverflow = eventRows.length >= FORENSIC_BATCH_SIZE;
      const touchedJobIds = new Set(eventRows.flatMap((row) => row.job_id ? [row.job_id] : []));
      const touchedJobs = touchedJobIds.size > 0 ? readJobsByIds(db, repoSlug, [...touchedJobIds], beadIdSelect, hasMetrics) : [];
      const jobs = mergeJobs(pageJobs, touchedJobs);
      const evidenceRefs = collectEvidenceRefs(repoSlug, eventRows);
      return {
        cursor: nextCursor(pageJobs, eventRows, baseline, hasForensic),
        rows: jobs,
        forensicEvents: eventRows.flatMap((row) => materializeForensicEvent(repoSlug, row)),
        evidenceRefs,
        hasMore: jobsOverflow || eventsOverflow,
      } satisfies MaterializerDelta<JobRow>;
    },
    async snapshot() {
      return { rows: readAllJobs(db, repoSlug, beadIdSelect, hasMetrics) } satisfies MaterializerSnapshot<JobRow>;
    },
    write(database, snapshot) {
      writeJobs(database, repoSlug, snapshot.rows);
      writeForensicEvents(database, snapshot.forensicEvents ?? []);
      writeEvidenceRefs(database, snapshot.evidenceRefs ?? []);
      cleanupMalformedSentinels(database, repoSlug);
    },
  };
}

function hasTable(db: Database, tableName: string): boolean {
  try {
    db.query(`SELECT 1 FROM ${tableName} LIMIT 0`).get();
    return true;
  } catch {
    return false;
  }
}

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  try {
    const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return columns.some((column) => column.name === columnName);
  } catch {
    return false;
  }
}

type SourceHighWater = { updatedAtMs: number; eventRowid: number; forensicRowid: number };

function sourceHighWater(db: Database, hasForensic: boolean): SourceHighWater {
  const jobMax = (db.query("SELECT MAX(updated_at_ms) AS m FROM specialist_jobs").get() as { m: number | null } | undefined)?.m;
  const forensicMax = hasForensic
    ? (db.query("SELECT MAX(rowid) AS m FROM specialist_forensic_events").get() as { m: number | null } | undefined)?.m
    : null;
  const legacyMax = hasForensic
    ? null
    : (db.query("SELECT MAX(id) AS m FROM specialist_events").get() as { m: number | null } | undefined)?.m;
  return {
    updatedAtMs: clampFinite(jobMax, 0),
    eventRowid: clampFinite(legacyMax, 0),
    forensicRowid: clampFinite(forensicMax, 0),
  };
}

function clampFinite(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

// Strictly validate a persisted positional cursor field: accept ONLY a genuine
// finite safe non-negative integer (typeof number). Numeric strings, fractional
// numbers, NaN/Infinity, negatives and unsafe integers are rejected (not
// coerced/floored) and trigger reset-aware replay. A valid cursor above the
// source high-water (on a non-empty source) signals a source reset/rewind, so we
// replay from 0 — safe because target writes are idempotent upserts — instead of
// clamping to the high-water and silently skipping the boundary row. An
// empty/pruned source (high-water 0) normalizes to 0 without a false reset.
function sanitizePosition(value: unknown, highWater: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  if (highWater <= 0) return 0;
  if (value > highWater) return 0;
  return value;
}

function normalizeCursor(cursor: unknown, highWater: SourceHighWater): ObservabilityCursor {
  const value = cursor as Partial<ObservabilityCursor> | null | undefined;
  const updatedAtMs = sanitizePosition(value?.updated_at_ms, highWater.updatedAtMs);
  // The tie-break job_id must be a bounded string. On a reset/invalid job
  // high-water, or an oversized/non-string job_id, restart the tie-break so
  // equal-timestamp rows are replayed (idempotent) rather than skipped or used
  // to inject an unbounded string into SQL comparisons.
  const rawJobId = typeof value?.job_id === "string" ? value.job_id : "";
  const jobId = updatedAtMs === 0 || rawJobId.length > JOB_ID_MAX_LEN ? "" : rawJobId;
  return {
    updated_at_ms: updatedAtMs,
    job_id: jobId,
    event_rowid: sanitizePosition(value?.event_rowid, highWater.eventRowid),
    forensic_rowid: sanitizePosition(value?.forensic_rowid ?? value?.event_rowid, highWater.forensicRowid),
  };
}

function readJobsSince(db: Database, repoSlug: string, cursor: ObservabilityCursor, beadIdSelect: string, hasMetrics: boolean): JobRow[] {
  return db.query(jobSelectSql(beadIdSelect, hasMetrics, "WHERE (j.updated_at_ms > ?) OR (j.updated_at_ms = ? AND j.job_id > ?) ORDER BY j.updated_at_ms ASC, j.job_id ASC LIMIT " + (JOB_BATCH_SIZE + 1)))
    .all(cursor.updated_at_ms, cursor.updated_at_ms, cursor.job_id)
    .map((row) => materializeJobRow(repoSlug, row as Record<string, unknown>));
}

function readAllJobs(db: Database, repoSlug: string, beadIdSelect: string, hasMetrics: boolean): JobRow[] {
  return db.query(jobSelectSql(beadIdSelect, hasMetrics, "ORDER BY j.updated_at_ms ASC, j.job_id ASC"))
    .all()
    .map((row) => materializeJobRow(repoSlug, row as Record<string, unknown>));
}

function readJobsByIds(db: Database, repoSlug: string, jobIds: readonly string[], beadIdSelect: string, hasMetrics: boolean): JobRow[] {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(", ");
  return db.query(jobSelectSql(beadIdSelect, hasMetrics, `WHERE j.job_id IN (${placeholders})`))
    .all(...jobIds)
    .map((row) => materializeJobRow(repoSlug, row as Record<string, unknown>));
}

function jobSelectSql(beadIdSelect: string, hasMetrics: boolean, suffix: string): string {
  const metricsJoin = hasMetrics ? "LEFT JOIN specialist_job_metrics AS m ON m.job_id = j.job_id" : "";
  const metricsColumns = hasMetrics
    ? `m.total_turns AS turns, m.total_tools AS tools, m.model AS model,
       CASE WHEN m.token_trajectory_json IS NULL OR length(CAST(m.token_trajectory_json AS BLOB)) <= ${TOKEN_TRAJECTORY_MAX_BYTES} THEN m.token_trajectory_json ELSE NULL END AS token_trajectory_json,
       CASE WHEN m.token_trajectory_json IS NULL THEN 0 ELSE length(CAST(m.token_trajectory_json AS BLOB)) END AS token_trajectory_bytes`
    : "NULL AS turns, NULL AS tools, NULL AS model, NULL AS token_trajectory_json, 0 AS token_trajectory_bytes";
  return `
    SELECT j.job_id, ${beadIdSelect}, j.specialist, j.status, j.chain_id, j.epic_id, j.chain_kind,
      j.worktree_column AS worktree,
      CASE WHEN j.last_output IS NULL OR length(CAST(j.last_output AS BLOB)) <= ${LAST_OUTPUT_MAX_BYTES} THEN j.last_output ELSE NULL END AS last_output,
      CASE WHEN j.last_output IS NULL THEN 0 ELSE length(CAST(j.last_output AS BLOB)) END AS last_output_bytes,
      j.updated_at_ms, ${metricsColumns}
    FROM specialist_jobs AS j
    ${metricsJoin}
    ${suffix}
  `;
}

function readForensicEventsSince(db: Database, rowid: number, limit: number): SourceEventRow[] {
  return db.query(`
    SELECT rowid AS _rowid, job_id, seq, t AS t_unix_ms, event_name AS event_type,
      CASE WHEN event_json IS NULL OR length(CAST(event_json AS BLOB)) <= ${EVENT_PAYLOAD_MAX_BYTES} THEN event_json ELSE NULL END AS payload,
      CASE WHEN event_json IS NULL THEN 0 ELSE length(CAST(event_json AS BLOB)) END AS payload_bytes
    FROM specialist_forensic_events
    WHERE rowid > ?
    ORDER BY rowid ASC
    LIMIT ?
  `).all(rowid, limit).map((row) => {
    const r = row as Record<string, unknown>;
    return { ...r, rowid: r._rowid, source: "forensic" as const };
  }) as SourceEventRow[];
}

function readLegacyEventsSince(db: Database, rowid: number, limit: number): SourceEventRow[] {
  return db.query(`
    SELECT id AS rowid, job_id, seq, t AS t_unix_ms, type AS event_type,
      CASE WHEN event_json IS NULL OR length(CAST(event_json AS BLOB)) <= ${EVENT_PAYLOAD_MAX_BYTES} THEN event_json ELSE NULL END AS payload,
      CASE WHEN event_json IS NULL THEN 0 ELSE length(CAST(event_json AS BLOB)) END AS payload_bytes
    FROM specialist_events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(rowid, limit).map((row) => ({ ...(row as Record<string, unknown>), source: "legacy" as const })) as SourceEventRow[];
}

function materializeJobRow(repoSlug: string, row: Record<string, unknown>): JobRow {
  const trajectoryBytes = Number(row.token_trajectory_bytes ?? 0);
  const tokens = parseTokenTrajectory(row.token_trajectory_json);
  const lastOutputBytes = Number(row.last_output_bytes ?? 0);
  const lastOutput = row.last_output == null
    ? (lastOutputBytes > 0 ? `[redacted:oversized:last_output:${lastOutputBytes}b]` : null)
    : String(row.last_output);
  const trajectoryOversized = row.token_trajectory_json == null && trajectoryBytes > 0;
  return {
    repo_slug: repoSlug,
    job_id: String(row.job_id),
    bead_id: row.bead_id == null ? null : String(row.bead_id),
    specialist: String(row.specialist),
    status: String(row.status),
    chain_id: row.chain_id == null ? null : String(row.chain_id),
    epic_id: row.epic_id == null ? null : String(row.epic_id),
    chain_kind: row.chain_kind == null ? null : String(row.chain_kind),
    worktree: row.worktree == null ? null : String(row.worktree),
    last_output: lastOutput,
    created_at: null,
    updated_at: null,
    updated_at_ms: row.updated_at_ms == null ? null : Number(row.updated_at_ms),
    turns: row.turns == null ? null : Number(row.turns),
    tools: row.tools == null ? null : Number(row.tools),
    model: row.model == null ? null : String(row.model),
    ...tokens,
    usage_source: row.token_trajectory_json == null
      ? (trajectoryOversized ? "specialist_job_metrics:oversized" : null)
      : "specialist_job_metrics",
  };
}

function materializeForensicEvent(repoSlug: string, row: SourceEventRow): MaterializedForensicEvent[] {
  const sourceKey = `obs:${repoSlug}`;
  const sourceEventId = `${row.source}:${row.rowid}`;
  if (row.payload == null && row.payload_bytes > 0) {
    return [oversizedEventMarker(repoSlug, sourceKey, sourceEventId, row)];
  }
  const envelope = parseEnvelope(row);
  if (!envelope) return [];
  const correlation = record(envelope.correlation);
  const jobId = stringValue(correlation.job_id) ?? row.job_id ?? null;
  const tUnixMs = numberValue(envelope.t_unix_ms) ?? row.t_unix_ms ?? null;
  return [{
    source_key: sourceKey,
    source_event_id: sourceEventId,
    repo_slug: repoSlug,
    job_id: jobId,
    seq: numberValue(envelope.seq) ?? row.seq ?? null,
    t_unix_ms: tUnixMs,
    timestamp: stringValue(envelope.timestamp) ?? (tUnixMs == null ? null : new Date(tUnixMs).toISOString()),
    schema_version: String(envelope.schema_version ?? "xtrm.forensic.v1"),
    severity: stringValue(envelope.severity) ?? null,
    event_family: stringValue(envelope.event_family) ?? familyFromName(stringValue(envelope.event_name) ?? row.event_type),
    event_name: stringValue(envelope.event_name) ?? row.event_type,
    event_version: numberValue(envelope.event_version),
    resource_json: stableJson(record(envelope.resource)),
    correlation_json: stableJson(correlation),
    body_json: stableJson(record(envelope.body)),
    redaction_json: stableJson(record(envelope.redaction, { status: "unknown" })),
    trace_json: optionalJson(envelope.trace),
    links_json: optionalJson(envelope.links),
    diagnostics_json: optionalJson(envelope.diagnostics),
    envelope_json: stableJson(envelope),
  }];
}

function oversizedEventMarker(repoSlug: string, sourceKey: string, sourceEventId: string, row: SourceEventRow): MaterializedForensicEvent {
  const tUnixMs = row.t_unix_ms ?? null;
  const body = {
    reason: "payload_oversized",
    payload_bytes: row.payload_bytes,
    limit_bytes: EVENT_PAYLOAD_MAX_BYTES,
    source_event_id: sourceEventId,
  };
  const envelope = {
    schema_version: "xtrm.forensic.v1",
    t_unix_ms: tUnixMs,
    seq: row.seq,
    severity: "warn",
    event_family: "observability",
    event_name: "observability.payload.oversized",
    event_version: 1,
    resource: {},
    correlation: { job_id: row.job_id },
    body,
    redaction: { status: "redacted" },
  };
  return {
    source_key: sourceKey,
    source_event_id: sourceEventId,
    repo_slug: repoSlug,
    job_id: row.job_id ?? null,
    seq: row.seq ?? null,
    t_unix_ms: tUnixMs,
    timestamp: tUnixMs == null ? null : new Date(tUnixMs).toISOString(),
    schema_version: envelope.schema_version,
    severity: envelope.severity,
    event_family: envelope.event_family,
    event_name: envelope.event_name,
    event_version: envelope.event_version,
    resource_json: stableJson(envelope.resource),
    correlation_json: stableJson(envelope.correlation),
    body_json: stableJson(body),
    redaction_json: stableJson(envelope.redaction),
    envelope_json: stableJson(envelope),
  };
}

function collectEvidenceRefs(repoSlug: string, eventRows: SourceEventRow[]): MaterializedEvidenceRef[] {
  const out: MaterializedEvidenceRef[] = [];
  for (const row of eventRows) {
    if (out.length >= EVIDENCE_REFS_PER_RUN_CAP) break;
    const refs = materializeEvidenceRefs(repoSlug, row);
    for (const ref of refs) {
      if (out.length >= EVIDENCE_REFS_PER_RUN_CAP) break;
      out.push(ref);
    }
  }
  return out;
}

function materializeEvidenceRefs(repoSlug: string, row: SourceEventRow): MaterializedEvidenceRef[] {
  const envelope = parseEnvelope(row);
  if (!envelope) return [];
  const sourceKey = `obs:${repoSlug}`;
  const body = record(envelope.body);
  const links = record(envelope.links);
  const refs = [...arrayValue(body.evidence_refs), ...arrayValue(links.evidence_refs), ...arrayValue(links.evidence)];
  const out: MaterializedEvidenceRef[] = [];
  refs.forEach((ref, index) => {
    if (out.length >= EVIDENCE_REFS_PER_EVENT_CAP) return;
    const value = record(ref);
    const kind = stringValue(value.evidence_kind) ?? stringValue(value.kind);
    if (!kind) return;
    const id = stringValue(value.id) ?? stringValue(value.ref) ?? `${row.source}:${row.rowid}:${index}`;
    const correlation = record(envelope.correlation);
    out.push({
      source_key: sourceKey,
      repo_slug: repoSlug,
      evidence_id: id,
      evidence_kind: kind,
      job_id: stringValue(correlation.job_id) ?? row.job_id ?? null,
      issue_id: stringValue(correlation.issue_id) ?? stringValue(correlation.bead_id) ?? null,
      event_source_id: `${row.source}:${row.rowid}`,
      ref_json: stableJson(value),
      created_at: stringValue(envelope.timestamp) ?? null,
    });
  });
  return out;
}

function parseEnvelope(row: SourceEventRow): Record<string, unknown> | null {
  if (!row.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const envelope = parsed as Record<string, unknown>;
    if (envelope.schema_version == null && row.source === "legacy") {
      return {
        schema_version: "xtrm.forensic.v1",
        t_unix_ms: row.t_unix_ms,
        seq: row.seq,
        severity: "info",
        event_family: familyFromName(row.event_type),
        event_name: row.event_type,
        event_version: 1,
        resource: {},
        correlation: { job_id: row.job_id },
        body: envelope,
        redaction: { status: "unknown" },
      };
    }
    return envelope;
  } catch {
    return null;
  }
}

function cleanupMalformedSentinels(database: Database, repoSlug: string): void {
  const sourceKey = `obs:${repoSlug}`;
  database.query("DELETE FROM xtrm_forensic_events WHERE source_key = ? AND source_event_id = 'forensic:undefined'").run(sourceKey);
  database.query("DELETE FROM xtrm_evidence_refs WHERE source_key = ? AND event_source_id = 'forensic:undefined'").run(sourceKey);
}

function writeJobs(database: Database, repoSlug: string, rows: readonly JobRow[]): void {
  const stmt = database.query(`
    INSERT INTO specialist_jobs (
      repo_slug, job_id, bead_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output,
      turns, tools, model, token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool, usage_source,
      created_at, updated_at, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_slug, job_id) DO UPDATE SET
      bead_id=excluded.bead_id, specialist=excluded.specialist, status=excluded.status, chain_id=excluded.chain_id,
      epic_id=excluded.epic_id, chain_kind=excluded.chain_kind, worktree=excluded.worktree, last_output=excluded.last_output,
      turns=excluded.turns, tools=excluded.tools, model=excluded.model, token_input=excluded.token_input,
      token_output=excluded.token_output, token_cache_read=excluded.token_cache_read, token_cache_creation=excluded.token_cache_creation,
      token_reasoning=excluded.token_reasoning, token_tool=excluded.token_tool, usage_source=excluded.usage_source,
      created_at=excluded.created_at, updated_at=excluded.updated_at, updated_at_ms=excluded.updated_at_ms
  `);
  for (const row of rows) {
    const timestamp = row.updated_at_ms ?? 0;
    const createdAt = new Date(timestamp).toISOString();
    const updatedAt = new Date(timestamp).toISOString();
    stmt.run(
      repoSlug, row.job_id, row.bead_id ?? null, row.specialist, row.status, row.chain_id ?? null, row.epic_id ?? null,
      row.chain_kind ?? null, row.worktree ?? null, row.last_output ?? null, row.turns ?? null, row.tools ?? null,
      row.model ?? null, row.token_input ?? null, row.token_output ?? null, row.token_cache_read ?? null,
      row.token_cache_creation ?? null, row.token_reasoning ?? null, row.token_tool ?? null, row.usage_source ?? null,
      createdAt, updatedAt, row.updated_at_ms ?? null,
    );
  }
}

function writeForensicEvents(database: Database, rows: readonly MaterializedForensicEvent[]): void {
  if (rows.length === 0) return;
  const stmt = database.query(`
    INSERT INTO xtrm_forensic_events (
      source_key, source_event_id, repo_slug, job_id, seq, t_unix_ms, timestamp, schema_version, severity,
      event_family, event_name, event_version, resource_json, correlation_json, body_json, redaction_json,
      trace_json, links_json, diagnostics_json, envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_event_id) DO UPDATE SET
      job_id=excluded.job_id, seq=excluded.seq, t_unix_ms=excluded.t_unix_ms, timestamp=excluded.timestamp,
      schema_version=excluded.schema_version, severity=excluded.severity, event_family=excluded.event_family,
      event_name=excluded.event_name, event_version=excluded.event_version, resource_json=excluded.resource_json,
      correlation_json=excluded.correlation_json, body_json=excluded.body_json, redaction_json=excluded.redaction_json,
      trace_json=excluded.trace_json, links_json=excluded.links_json, diagnostics_json=excluded.diagnostics_json,
      envelope_json=excluded.envelope_json
  `);
  for (const row of rows) {
    stmt.run(row.source_key, row.source_event_id, row.repo_slug, row.job_id ?? null, row.seq ?? null, row.t_unix_ms ?? null,
      row.timestamp ?? null, row.schema_version, row.severity ?? null, row.event_family ?? null, row.event_name ?? null,
      row.event_version ?? null, row.resource_json, row.correlation_json, row.body_json, row.redaction_json,
      row.trace_json ?? null, row.links_json ?? null, row.diagnostics_json ?? null, row.envelope_json);
  }
}

function writeEvidenceRefs(database: Database, rows: readonly MaterializedEvidenceRef[]): void {
  if (rows.length === 0) return;
  const stmt = database.query(`
    INSERT INTO xtrm_evidence_refs (source_key, repo_slug, evidence_id, evidence_kind, job_id, issue_id, event_source_id, ref_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, evidence_id) DO UPDATE SET evidence_kind=excluded.evidence_kind, job_id=excluded.job_id,
      issue_id=excluded.issue_id, event_source_id=excluded.event_source_id, ref_json=excluded.ref_json, created_at=excluded.created_at
  `);
  for (const row of rows) {
    stmt.run(row.source_key, row.repo_slug, row.evidence_id, row.evidence_kind, row.job_id ?? null, row.issue_id ?? null,
      row.event_source_id ?? null, row.ref_json, row.created_at ?? null);
  }
}

function mergeJobs(primary: JobRow[], touched: JobRow[]): JobRow[] {
  const rows = new Map<string, JobRow>();
  for (const row of primary) rows.set(row.job_id, row);
  for (const row of touched) rows.set(row.job_id, row);
  return [...rows.values()].sort((left, right) => (left.updated_at_ms ?? 0) - (right.updated_at_ms ?? 0) || left.job_id.localeCompare(right.job_id));
}

function nextCursor(jobs: JobRow[], events: SourceEventRow[], baseline: ObservabilityCursor, hasForensic: boolean): ObservabilityCursor {
  // Job high-water advances only from the ordered, paginated job scan so the
  // stable (updated_at_ms, job_id) tuple never regresses or drops equal stamps.
  let jobUpdatedAt = baseline.updated_at_ms;
  let jobId = baseline.job_id;
  for (const row of jobs) {
    const ts = row.updated_at_ms ?? 0;
    if (ts > jobUpdatedAt || (ts === jobUpdatedAt && row.job_id > jobId)) {
      jobUpdatedAt = ts;
      jobId = row.job_id;
    }
  }
  const maxEvent = events.reduce((max, row) => Math.max(max, row.rowid ?? 0), hasForensic ? baseline.forensic_rowid : baseline.event_rowid);
  return hasForensic
    ? { updated_at_ms: jobUpdatedAt, job_id: jobId, event_rowid: baseline.event_rowid, forensic_rowid: maxEvent }
    : { updated_at_ms: jobUpdatedAt, job_id: jobId, event_rowid: maxEvent, forensic_rowid: baseline.forensic_rowid };
}

function parseTokenTrajectory(value: unknown): TokenTotals {
  const out = { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, token_reasoning: 0, token_tool: 0 };
  for (const item of arrayFromJson(value)) {
    const usage = record(record(item).token_usage);
    out.token_input += numberValue(usage.input_tokens) ?? 0;
    out.token_output += numberValue(usage.output_tokens) ?? 0;
    out.token_cache_read += numberValue(usage.cache_read_tokens) ?? 0;
    out.token_cache_creation += numberValue(usage.cache_creation_tokens) ?? 0;
    out.token_reasoning += numberValue(usage.reasoning_tokens) ?? 0;
    out.token_tool += numberValue(usage.tool_tokens) ?? 0;
  }
  return out;
}

function arrayFromJson(value: unknown): unknown[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function familyFromName(value: string | null | undefined): string | null {
  return value?.split(".")[0] ?? null;
}

function record(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fallback;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function optionalJson(value: unknown): string | null {
  return value == null ? null : stableJson(value);
}
