// Pure SQL query services for the Sources read model.
// Owns source listing, historical-data existence checks, and mutation helpers
// (pin / unpin) against the durable `sources` and `materialization_state`
// tables.
//
// `apps/console` is responsible for the mutating route gating (admin token,
// origin/host checks, allowed kinds); the helpers here operate on already-
// validated arguments and never authorize the caller.

import type { Database } from "bun:sqlite";

export interface SourceRow {
  source_key: string;
  kind: string;
  path: string;
  origin: string;
  status: string;
  discovered_at: string | null;
  last_seen_at: string | null;
}

export interface PinResult {
  source_key: string;
  kind: string;
  path: string;
}

export type UnpinResult =
  | { source_key: string; status: "unpinned" }
  | { source_key: string; status: "deleted" };

export const SOURCE_KEY_PREFIXES = ["beads", "observability", "github"] as const;
export type AllowedSourceKind = (typeof SOURCE_KEY_PREFIXES)[number];

const MUTABLE_ORIGINS = new Set(["manual"]);

export function listSources(db: Database | null | undefined): SourceRow[] {
  if (!db) return [];
  return db.query<SourceRow, []>(
    "SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources ORDER BY kind ASC, source_key ASC"
  ).all();
}

export function getSourceRow(db: Database | null | undefined, sourceKey: string): SourceRow | null {
  if (!db) return null;
  return db.query<SourceRow, [string]>(
    "SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources WHERE source_key = ? LIMIT 1"
  ).get(sourceKey) ?? null;
}

export function parseSourceKey(sourceKey: string): { kind: string; path: string } {
  const index = sourceKey.indexOf(":");
  if (index < 0) return { kind: "beads", path: sourceKey };
  return { kind: sourceKey.slice(0, index), path: sourceKey.slice(index + 1) };
}

export function buildSourceKey(kind: string, path: string): string {
  return `${kind}:${path}`;
}

export function isAllowedSourceKind(kind: string): kind is AllowedSourceKind {
  return (SOURCE_KEY_PREFIXES as readonly string[]).includes(kind);
}

export function isMutableManualSource(row: SourceRow | null): boolean {
  return row?.origin != null && MUTABLE_ORIGINS.has(row.origin);
}

export function hasHistoricalData(db: Database | null | undefined, sourceKey: string): boolean {
  if (!db) return false;
  const state = db.query("SELECT 1 FROM materialization_state WHERE source_key = ? LIMIT 1").get(sourceKey);
  if (state) return true;
  const { kind, path } = parseSourceKey(sourceKey);
  if (kind === "beads") {
    const repoSlug = path.split(/[\\/]+/).pop() ?? path;
    return Boolean(
      db.query("SELECT 1 FROM substrate_issues WHERE repo_slug = ? LIMIT 1").get(repoSlug)
      || db.query("SELECT 1 FROM specialist_jobs WHERE bead_id = ? LIMIT 1").get(repoSlug)
    );
  }
  if (kind === "observability") {
    return Boolean(db.query("SELECT 1 FROM specialist_jobs WHERE chain_id = ? LIMIT 1").get(sourceKey));
  }
  return false;
}

export function pinSource(db: Database | null | undefined, kind: string, path: string): PinResult {
  if (!db) throw new Error("xtrm.sqlite unavailable");
  const sourceKey = buildSourceKey(kind, path);
  db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, ?, ?, 'manual', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind, path=excluded.path, origin='manual', status='active', last_seen_at=CURRENT_TIMESTAMP").run(sourceKey, kind, path);
  return { source_key: sourceKey, kind, path };
}

export function unpinSource(db: Database | null | undefined, sourceKey: string): UnpinResult {
  if (!db) throw new Error("xtrm.sqlite unavailable");
  if (hasHistoricalData(db, sourceKey)) {
    db.query("UPDATE sources SET status = 'unpinned' WHERE source_key = ? AND origin = 'manual'").run(sourceKey);
    return { source_key: sourceKey, status: "unpinned" };
  }
  db.query("DELETE FROM sources WHERE source_key = ? AND origin = 'manual'").run(sourceKey);
  return { source_key: sourceKey, status: "deleted" };
}

export function getBeadsSourcePath(db: Database | null | undefined, projectId: string): string | null {
  if (!db) return null;
  const row = db.query<{ path: string }, [string]>(
    "SELECT path FROM sources WHERE kind = 'beads' AND source_key = ? LIMIT 1"
  ).get(`beads:${projectId}`);
  return row?.path ?? null;
}

export interface SourceMaterializationState {
  last_status: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

export function readSourceMaterializationState(db: Database | null | undefined, sourceKey: string): SourceMaterializationState | null {
  if (!db) return null;
  return db.query<SourceMaterializationState, [string]>(
    "SELECT last_status, last_success_at, last_error FROM materialization_state WHERE source_key = ? LIMIT 1"
  ).get(sourceKey) ?? null;
}
