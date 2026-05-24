import { Database } from "bun:sqlite";
import type { MaterializerAdapter, MaterializerCursor, MaterializerDelta, MaterializerSnapshot } from "./types.ts";

type ObservabilityCursor = {
  updated_at_ms: number;
  event_rowid: number;
};

type JobRow = {
  job_id: string;
  specialist: string | null;
  status: string;
  chain_id: string | null;
  epic_id: string | null;
  chain_kind: string | null;
  worktree: string | null;
  last_output: string | null;
  updated_at_ms: number | null;
};

type EventRow = {
  rowid: number;
  job_id: string;
  event_type: string;
  payload: string | null;
};

export function createObservabilityAdapter(dbPath: string, repoSlug: string): MaterializerAdapter<JobRow> {
  const db = new Database(dbPath);
  return {
    async cursor() {
      return { updated_at_ms: 0, event_rowid: 0 };
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
        rows: jobs,
      } satisfies MaterializerDelta<JobRow>;
    },
    async snapshot() {
      return { rows: readAllJobs(db, repoSlug) } satisfies MaterializerSnapshot<JobRow>;
    },
    write(database, snapshot) {
      const stmt = database.query("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_slug, job_id) DO UPDATE SET specialist=excluded.specialist, status=excluded.status, chain_id=excluded.chain_id, epic_id=excluded.epic_id, chain_kind=excluded.chain_kind, worktree=excluded.worktree, last_output=excluded.last_output, created_at=excluded.created_at, updated_at=excluded.updated_at, updated_at_ms=excluded.updated_at_ms");
      for (const row of snapshot.rows) {
        const timestamp = row.updated_at_ms ?? 0;
        const createdAt = new Date(timestamp).toISOString();
        const updatedAt = new Date(timestamp).toISOString();
        stmt.run(repoSlug, row.job_id, row.specialist ?? null, row.status, row.chain_id ?? null, row.epic_id ?? null, row.chain_kind ?? null, row.worktree ?? null, row.last_output ?? null, createdAt, updatedAt, row.updated_at_ms ?? null);
      }
    },
  };
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
    "SELECT job_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column AS worktree, last_output, updated_at_ms FROM specialist_jobs WHERE updated_at_ms > ? ORDER BY updated_at_ms ASC, job_id ASC",
  ).all(updatedAtMs) as JobRow[];
}

function readAllJobs(db: Database, repoSlug: string): JobRow[] {
  return db.query(
    "SELECT job_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column AS worktree, last_output, updated_at_ms FROM specialist_jobs ORDER BY updated_at_ms ASC, job_id ASC",
  ).all() as JobRow[];
}

function readJobsByIds(db: Database, repoSlug: string, jobIds: readonly string[]): JobRow[] {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(", ");
  return db.query(
    `SELECT job_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column AS worktree, last_output, updated_at_ms FROM specialist_jobs WHERE job_id IN (${placeholders})`,
  ).all(...jobIds) as JobRow[];
}

function readEventsSince(db: Database, repoSlug: string, rowid: number): EventRow[] {
  return db.query(
    "SELECT id AS rowid, job_id, type AS event_type, event_json AS payload FROM specialist_events WHERE id > ? ORDER BY id ASC",
  ).all(rowid) as EventRow[];
}

function mergeJobs(primary: JobRow[], touched: JobRow[]): JobRow[] {
  const rows = new Map<string, JobRow>();
  for (const row of primary) rows.set(row.job_id, row);
  for (const row of touched) rows.set(row.job_id, row);
  return [...rows.values()].sort((left, right) => (left.updated_at_ms ?? 0) - (right.updated_at_ms ?? 0) || left.job_id.localeCompare(right.job_id));
}

function nextCursor(jobs: JobRow[], events: EventRow[], baseline: ObservabilityCursor): ObservabilityCursor {
  const maxJob = jobs.reduce((max, row) => Math.max(max, row.updated_at_ms ?? 0), baseline.updated_at_ms);
  const maxEvent = events.reduce((max, row) => Math.max(max, row.rowid ?? 0), baseline.event_rowid);
  return { updated_at_ms: maxJob, event_rowid: maxEvent };
}
