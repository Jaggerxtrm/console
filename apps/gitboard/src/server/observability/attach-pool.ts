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
      logger.warn(`Skip observability db ${entry.dbPath}: probe failed (${errorMessage(err)})`);
      return false;
    }
    if (!isCompatible(pragma)) {
      logger.warn(`Skip observability db ${entry.dbPath}: schema_version ${pragma} incompatible`);
      return false;
    }

    try {
      db.exec(`ATTACH DATABASE '${escapeSql(entry.dbPath)}' AS ${alias}`);
    } catch (err) {
      logger.warn(`Skip observability db ${entry.dbPath}: attach failed (${errorMessage(err)})`);
      return false;
    }
    const attachedRepo = { ...entry, alias };
    attached.set(entry.dbPath, attachedRepo);
    lru.set(entry.dbPath, attachedRepo);
    return true;
  }

  function readSchemaVersion(path: string): number {
    const probe = new Database(path, { readonly: true });
    try {
      const row = probe.prepare("PRAGMA schema_version").get() as { schema_version?: number } | undefined;
      return row?.schema_version ?? 0;
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
