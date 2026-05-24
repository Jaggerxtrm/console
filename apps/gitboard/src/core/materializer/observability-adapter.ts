import { Database } from "bun:sqlite";
import type { MaterializedIssue, MaterializerAdapter, MaterializerCursor, MaterializerDelta, MaterializerSnapshot } from "./types.ts";

type ObservabilityCursor = {
  updated_at_ms: number;
  event_rowid: number;
};

type JobRow = {
  repo_slug: string;
  job_id: string;
  specialist: string | null;
  status: string;
  chain_id: string | null;
  epic_id: string | null;
  chain_kind: string | null;
  worktree: string | null;
  last_output: string | null;
  created_at: string | null;
  updated_at: string | null;
  updated_at_ms: number | null;
};

type EventRow = {
  rowid: number;
  repo_slug: string;
  job_id: string;
  event_type: string;
  payload: string | null;
  created_at: string | null;
};

export function createObservabilityAdapter(dbPath: string, repoSlug: string): MaterializerAdapter {
  const db = new Database(dbPath, { readonly: true });
  return {
    async cursor() {
      return readCursor(db, repoSlug);
    },
    async changesSince(cursor) {
      const baseline = normalizeCursor(cursor);
      const recentJobs = readJobsSince(db, repoSlug, baseline.updated_at_ms - 1000);
      const eventRows = readEventsSince(db, repoSlug, baseline.event_rowid);
      const touchedJobIds = new Set(eventRows.map((row) => row.job_id));
      const touchedJobs = touchedJobIds.size > 0 ? readJobsByIds(db, repoSlug, [...touchedJobIds]) : [];
      const jobs = mergeJobs(recentJobs, touchedJobs);
      return {
        cursor: nextCursor(jobs, eventRows, baseline),
        rows: jobs.map(toMaterializedIssue),
      } satisfies MaterializerDelta;
    },
    async snapshot() {
      return { rows: readAllJobs(db, repoSlug).map(toMaterializedIssue) } satisfies MaterializerSnapshot;
    },
  };
}

function readCursor(db: Database, repoSlug: string): ObservabilityCursor {
  const row = db.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(`obs:${repoSlug}`) as { cursor: string | null } | undefined;
  if (!row?.cursor) return { updated_at_ms: 0, event_rowid: 0 };
  const parsed = JSON.parse(row.cursor) as Partial<ObservabilityCursor>;
  return normalizeCursor(parsed);
}

function normalizeCursor(cursor: unknown): ObservabilityCursor {
  const value = cursor as Partial<ObservabilityCursor> | null | undefined;
  return {
    updated_at_ms: Number(value?.updated_at_ms ?? 0),
    event_rowid: Number(value?.event_rowid ?? 0),
  };
}

function readJobsSince(db: Database, repoSlug: string, updatedAtMs: number): JobRow[] {
  return db.query(
    "SELECT repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms FROM specialist_jobs WHERE repo_slug = ? AND updated_at_ms > ? ORDER BY updated_at_ms ASC, job_id ASC",
  ).all(repoSlug, updatedAtMs) as JobRow[];
}

function readAllJobs(db: Database, repoSlug: string): JobRow[] {
  return db.query(
    "SELECT repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms FROM specialist_jobs WHERE repo_slug = ? ORDER BY updated_at_ms ASC, job_id ASC",
  ).all(repoSlug) as JobRow[];
}

function readJobsByIds(db: Database, repoSlug: string, jobIds: readonly string[]): JobRow[] {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(", ");
  return db.query(
    `SELECT repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms FROM specialist_jobs WHERE repo_slug = ? AND job_id IN (${placeholders})`,
  ).all(repoSlug, ...jobIds) as JobRow[];
}

function readEventsSince(db: Database, repoSlug: string, rowid: number): EventRow[] {
  return db.query(
    "SELECT id AS rowid, repo_slug, job_id, event_type, payload, created_at FROM specialist_job_events WHERE repo_slug = ? AND id > ? ORDER BY id ASC",
  ).all(repoSlug, rowid) as EventRow[];
}

function mergeJobs(primary: JobRow[], touched: JobRow[]): JobRow[] {
  const rows = new Map<string, JobRow>();
  for (const row of primary) rows.set(row.job_id, row);
  for (const row of touched) rows.set(row.job_id, row);
  return [...rows.values()].sort((left, right) => left.updated_at_ms - right.updated_at_ms || left.job_id.localeCompare(right.job_id));
}

function nextCursor(jobs: JobRow[], events: EventRow[], baseline: ObservabilityCursor): ObservabilityCursor {
  const maxJob = jobs.reduce((max, row) => Math.max(max, row.updated_at_ms ?? 0), baseline.updated_at_ms);
  const maxEvent = events.reduce((max, row) => Math.max(max, row.rowid ?? 0), baseline.event_rowid);
  return { updated_at_ms: maxJob, event_rowid: maxEvent };
}

function toMaterializedIssue(row: JobRow): MaterializedIssue {
  return {
    repo_slug: row.repo_slug,
    issue_id: row.job_id,
    title: row.specialist ?? row.job_id,
    body: row.last_output,
    state: mapState(row.status),
    deleted_at: row.status === "deleted" ? row.updated_at : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapState(status: string): string {
  if (status === "done" || status === "cancelled") return "closed";
  if (status === "deleted") return "deleted";
  return "open";
}
