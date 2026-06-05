import { Buffer } from "node:buffer";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";

type FeedSource = "specialists" | "beads" | "github" | "materializer";
type Severity = "debug" | "info" | "warn" | "error";
type RedactionStatus = "clean" | "redacted";

interface FeedRow {
  id: string;
  source: FeedSource;
  kind: string;
  repo_slug: string;
  title: string;
  summary: string;
  t_unix_ms: number;
  seq: number;
  severity: Severity;
  status: string;
  redaction_status: RedactionStatus;
  drilldown: {
    job_id?: string;
    issue_id?: string;
    github_event_id?: string;
    forensic_event_ids?: number[];
    evidence_ids?: string[];
  };
}

interface FeedCursor {
  t_unix_ms: number;
  seq: number;
  id?: string;
}

export function createFeedRouter(db?: Database | null): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const cursor = parseCursor(c.req.query("cursor"));
    const rows = readFeedRows(db, cursor).sort(compareFeedRows).slice(0, limit);
    return c.json({ rows, cursor: { limit, next: rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null } });
  });

  return router;
}

function readFeedRows(db: Database | null | undefined, cursor: FeedCursor | null): FeedRow[] {
  if (!db) return [];
  return [
    ...readSpecialistRows(db),
    ...readBeadsRows(db),
    ...readGithubRows(db),
  ].filter((row) => isAfterCursor(row, cursor));
}

function readSpecialistRows(db: Database): FeedRow[] {
  if (!hasTable(db, "xtrm_forensic_events")) return [];
  const rows = db.query(`
    SELECT id, repo_slug, job_id, seq, t_unix_ms, severity, event_family, event_name,
           redaction_json, body_json, resource_json
    FROM xtrm_forensic_events
    ORDER BY t_unix_ms ASC, seq ASC, id ASC
  `).all() as Array<Record<string, unknown>>;
  const evidenceByJob = readEvidenceByJob(db);

  return rows.flatMap((row) => {
    const eventFamily = String(row.event_family ?? "event");
    const eventName = String(row.event_name ?? "unknown");
    const source: FeedSource = eventFamily === "materializer" ? "materializer" : "specialists";
    const jobId = row.job_id == null ? undefined : String(row.job_id);
    const eventId = Number(row.id);
    const redaction = parseJsonObject(row.redaction_json);
    const resource = parseJsonObject(row.resource_json);
    const evidenceRefs = extractEvidenceIds(parseJsonObject(row.body_json), jobId ? evidenceByJob.get(jobId) : undefined);
    const kind = source === "materializer" && eventName.includes("malformed") ? "malformed_source_row" : eventName.replace(/\./g, "_");
    const role = typeof resource?.participant_role === "string" ? resource.participant_role : eventFamily;
    return [{
      id: `${source}:${row.repo_slug}:${jobId ?? "none"}:${Number(row.t_unix_ms ?? 0)}:${Number(row.seq ?? 0)}:${eventId}`,
      source,
      kind,
      repo_slug: String(row.repo_slug ?? "unknown"),
      title: source === "materializer" ? "Skipped malformed feed source row" : `${role} ${eventName}`,
      summary: eventName,
      t_unix_ms: Number(row.t_unix_ms ?? 0),
      seq: Number(row.seq ?? 0),
      severity: normalizeSeverity(row.severity),
      status: kind.endsWith("completed") ? "done" : source === "materializer" ? "degraded" : "event",
      redaction_status: normalizeRedaction(redaction?.status),
      drilldown: {
        ...(jobId ? { job_id: jobId } : {}),
        forensic_event_ids: [eventId],
        ...(evidenceRefs.length > 0 ? { evidence_ids: evidenceRefs } : {}),
      },
    }];
  });
}

function readBeadsRows(db: Database): FeedRow[] {
  if (!hasTable(db, "substrate_issues")) return [];
  const rows = db.query(`
    SELECT repo_slug, issue_id, title, state, updated_at, created_at
    FROM substrate_issues
    WHERE deleted_at IS NULL OR deleted_at = ''
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const issueId = String(row.issue_id ?? "unknown");
    const state = String(row.state ?? "open");
    const t = dateToUnixMs(row.updated_at ?? row.created_at);
    return {
      id: `beads:${row.repo_slug}:${issueId}:${t}:0`,
      source: "beads",
      kind: "issue_updated",
      repo_slug: String(row.repo_slug ?? "unknown"),
      title: String(row.title ?? issueId),
      summary: `issue status ${state}`,
      t_unix_ms: t,
      seq: 0,
      severity: "info",
      status: state,
      redaction_status: "clean",
      drilldown: { issue_id: issueId },
    };
  });
}

function readGithubRows(db: Database): FeedRow[] {
  if (!hasTable(db, "github_events")) return [];
  const rows = db.query(`
    SELECT id, type, repo, action, title, created_at
    FROM github_events
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const eventId = String(row.id ?? "unknown");
    const type = String(row.type ?? "github_event");
    const action = row.action == null ? "" : String(row.action);
    const t = dateToUnixMs(row.created_at);
    return {
      id: `github:${row.repo}:${eventId}`,
      source: "github",
      kind: type.toLowerCase(),
      repo_slug: String(row.repo ?? "unknown"),
      title: String(row.title ?? type),
      summary: action || type,
      t_unix_ms: t,
      seq: 0,
      severity: "info",
      status: action || "event",
      redaction_status: "clean",
      drilldown: { github_event_id: eventId },
    };
  });
}

function readEvidenceByJob(db: Database): Map<string, string[]> {
  if (!hasTable(db, "xtrm_evidence_refs")) return new Map();
  const rows = db.query("SELECT job_id, evidence_id FROM xtrm_evidence_refs WHERE job_id IS NOT NULL").all() as Array<{ job_id: string; evidence_id: string }>;
  const byJob = new Map<string, string[]>();
  for (const row of rows) {
    const list = byJob.get(row.job_id) ?? [];
    list.push(row.evidence_id);
    byJob.set(row.job_id, list);
  }
  return byJob;
}

function extractEvidenceIds(body: Record<string, unknown> | null, fallback: string[] | undefined): string[] {
  const refs = Array.isArray(body?.evidence_refs) ? body.evidence_refs : [];
  const ids = refs.flatMap((ref) => {
    if (!ref || typeof ref !== "object") return [];
    const id = (ref as Record<string, unknown>).id ?? (ref as Record<string, unknown>).evidence_id;
    return typeof id === "string" ? [id] : [];
  });
  return ids.length > 0 ? ids : fallback ?? [];
}

function compareFeedRows(a: FeedRow, b: FeedRow): number {
  return a.t_unix_ms - b.t_unix_ms || a.seq - b.seq || a.id.localeCompare(b.id);
}

function isAfterCursor(row: FeedRow, cursor: FeedCursor | null): boolean {
  if (!cursor) return true;
  if (row.t_unix_ms !== cursor.t_unix_ms) return row.t_unix_ms > cursor.t_unix_ms;
  if (row.seq !== cursor.seq) return row.seq > cursor.seq;
  return cursor.id ? row.id > cursor.id : true;
}

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parseCursor(value: string | undefined): FeedCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FeedCursor>;
    return typeof parsed.t_unix_ms === "number" && typeof parsed.seq === "number" ? { t_unix_ms: parsed.t_unix_ms, seq: parsed.seq, id: typeof parsed.id === "string" ? parsed.id : undefined } : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: FeedRow): string {
  return Buffer.from(JSON.stringify({ t_unix_ms: row.t_unix_ms, seq: row.seq, id: row.id }), "utf8").toString("base64url");
}

function normalizeSeverity(value: unknown): Severity {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function normalizeRedaction(value: unknown): RedactionStatus {
  return value === "redacted" ? "redacted" : "clean";
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function dateToUnixMs(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return Boolean(row);
}
