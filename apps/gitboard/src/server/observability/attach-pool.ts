import { Database } from "bun:sqlite";
import { isCompatible } from "./schema-guard.js";

type RepoEntry = {
  repoSlug: string;
  repoPath: string;
  dbPath: string;
  mtimeMs: number;
};

type Logger = Pick<Console, "warn">;

type PoolOptions = {
  maxAttached?: number;
  logger?: Logger;
};

type AttachedRepo = RepoEntry & { alias: string };

const DEFAULT_MAX_ATTACHED = 12;

export function createAttachPool(entries: readonly RepoEntry[], options: PoolOptions = {}) {
  const maxAttached = options.maxAttached ?? DEFAULT_MAX_ATTACHED;
  const logger = options.logger ?? console;
  const db = new Database(":memory:", { create: true });
  const attached = new Map<string, AttachedRepo>();
  const lru = new Map<string, AttachedRepo>();
  // Cache dbs we've already determined to be unhealthy (incompatible schema, probe failed,
  // attach failed) so the file-watcher can't trigger an infinite re-probe loop on the
  // same dead db. Each entry stores the mtime at the time we marked it dead — if the file
  // is rewritten (newer mtime), we drop the cache entry and try again.
  const dead = new Map<string, { mtimeMs: number; reason: string }>();
  let aliasCounter = 0;

  function withAttached<T>(fn: (db: Database, attached: ReadonlyArray<{ alias: string; slug: string }>) => T): T {
    attachHealthyRepos();
    try {
      const list = Array.from(attached.values()).map((entry) => ({ alias: entry.alias, slug: entry.repoSlug }));
      return fn(db, list);
    } finally {
      trimToLimit();
    }
  }

  function attachHealthyRepos(): void {
    for (const entry of entries) {
      if (attached.has(entry.dbPath)) {
        touch(entry.dbPath);
        continue;
      }

      // Skip dbs already known to be unhealthy unless they've been rewritten.
      const deadEntry = dead.get(entry.dbPath);
      if (deadEntry && deadEntry.mtimeMs >= entry.mtimeMs) continue;
      if (deadEntry) dead.delete(entry.dbPath);

      if (!ensureCapacity()) break;
      if (!attachRepo(entry)) continue;
    }
  }

  function ensureCapacity(): boolean {
    if (attached.size < maxAttached) return true;
    const oldest = lru.keys().next().value as string | undefined;
    if (!oldest) return false;
    detachRepo(oldest);
    return true;
  }

  function attachRepo(entry: RepoEntry): boolean {
    const alias = `repo_${entry.repoSlug.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${aliasCounter++}`;
    let pragma: number;
    try {
      pragma = readSchemaVersion(entry.dbPath);
    } catch (err) {
      markDead(entry, `probe failed (${errorMessage(err)})`);
      return false;
    }
    if (!isCompatible(pragma)) {
      markDead(entry, `schema_version ${pragma} incompatible`);
      return false;
    }

    try {
      db.exec(`ATTACH DATABASE '${escapeSql(entry.dbPath)}' AS ${alias}`);
    } catch (err) {
      markDead(entry, `attach failed (${errorMessage(err)})`);
      return false;
    }
    const attachedRepo = { ...entry, alias };
    attached.set(entry.dbPath, attachedRepo);
    lru.set(entry.dbPath, attachedRepo);
    return true;
  }

  // Cache a dead db with its current mtime. Only log the first time we see this db dead;
  // subsequent attempts (same mtime) silently skip. The file watcher can fire many times
  // on a single file change, so the cache stops a runaway log loop.
  function markDead(entry: RepoEntry, reason: string): void {
    const prev = dead.get(entry.dbPath);
    if (!prev || prev.reason !== reason) {
      logger.warn(`Skip observability db ${entry.dbPath}: ${reason}`);
    }
    dead.set(entry.dbPath, { mtimeMs: entry.mtimeMs, reason });
  }

  function readSchemaVersion(path: string): number {
    // We read sp's observability dbs which evolve schema versions over time.
    // The actual contract that matters is column shape on specialist_jobs, not the version number.
    // Return 1 if the table exists (compatible), 0 otherwise (skip).
    const probe = new Database(path, { readonly: true });
    try {
      const hasJobsTable = probe.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='specialist_jobs'",
      ).get();
      return hasJobsTable ? 1 : 0;
    } finally {
      probe.close();
    }
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function detachRepo(dbPath: string): void {
    const entry = attached.get(dbPath);
    if (!entry) return;
    db.exec(`DETACH DATABASE ${entry.alias}`);
    attached.delete(dbPath);
    lru.delete(dbPath);
  }

  function touch(dbPath: string): void {
    const entry = lru.get(dbPath);
    if (!entry) return;
    lru.delete(dbPath);
    lru.set(dbPath, entry);
  }

  function trimToLimit(): void {
    while (attached.size > maxAttached) {
      const oldest = lru.keys().next().value as string | undefined;
      if (!oldest) break;
      detachRepo(oldest);
    }
  }

  return { withAttached };
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
