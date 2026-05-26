import { Database } from "bun:sqlite";
import { isCompatible } from "./schema-guard.js";
import type { ObservabilityCoverage } from "./types.js";

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

type CoverageState = {
  attached: string[];
  skipped: Array<{ slug: string; reason: string }>;
};

const DEFAULT_MAX_ATTACHED = 8;
const MIN_MAX_ATTACHED = 1;
const MAX_MAX_ATTACHED = 10;

const moduleDead = new Map<string, { reason: string }>();

export function createAttachPool(entries: readonly RepoEntry[], options: PoolOptions = {}) {
  const maxAttached = clampMaxAttached(options.maxAttached ?? DEFAULT_MAX_ATTACHED);
  const logger = options.logger ?? console;
  const db = new Database(":memory:", { create: true });
  const attached = new Map<string, AttachedRepo>();
  const lru = new Map<string, AttachedRepo>();
  const dead = moduleDead;
  const coverage: CoverageState = { attached: [], skipped: [] };
  let aliasCounter = 0;
  let warmPromise: Promise<void> | null = null;

  void warmAttachPool();

  function withAttached<T>(fn: (db: Database, attached: ReadonlyArray<{ alias: string; slug: string }>) => T): T {
    const list = Array.from(attached.values()).map((entry) => ({ alias: entry.alias, slug: entry.repoSlug }));
    return fn(db, list);
  }

  function getCoverage(): ObservabilityCoverage {
    return {
      attached: Array.from(attached.values()).map((entry) => entry.repoSlug),
      skipped: [...coverage.skipped],
      totalDiscovered: entries.length,
    };
  }

  async function warmAttachPool(): Promise<void> {
    if (warmPromise) return warmPromise;

    warmPromise = (async () => {
      let processed = 0;
      for (const entry of entries) {
        if (attached.has(entry.dbPath)) {
          touch(entry.dbPath);
          continue;
        }
        if (dead.has(entry.dbPath)) continue;
        if (!ensureCapacity()) {
          recordSkipped(entry.repoSlug, "capacity reached");
          continue;
        }
        if (!attachRepo(entry)) continue;
        processed += 1;
        if (processed % 5 === 0) await yieldToEventLoop();
      }
      if (coverage.skipped.length > 0) {
        logger.warn(`Observability coverage degraded: attached ${attached.size}/${entries.length}, skipped ${coverage.skipped.length}`);
      }
    })()
      .catch((err) => {
        logger.warn(`Attach pool warm failed: ${errorMessage(err)}`);
      })
      .finally(() => {
        warmPromise = null;
      });

    return warmPromise;
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
    const probe = new Database(entry.dbPath, { readonly: true });
    let pragma: number;
    try {
      pragma = readSchemaVersion(probe);
      if (!isCompatible(probe)) {
        markDead(entry, `schema_version ${pragma} incompatible or missing required tables`);
        return false;
      }
    } catch (err) {
      markDead(entry, `probe failed (${errorMessage(err)})`);
      return false;
    } finally {
      probe.close();
    }

    try {
      db.exec(`ATTACH DATABASE '${escapeSql(entry.dbPath)}' AS ${alias}`);
    } catch (err) {
      const message = errorMessage(err);
      if (isAttachLimitError(message)) {
        recordSkipped(entry.repoSlug, message);
        return false;
      }
      markDead(entry, `attach failed (${message})`);
      return false;
    }

    const attachedRepo = { ...entry, alias };
    attached.set(entry.dbPath, attachedRepo);
    lru.set(entry.dbPath, attachedRepo);
    return true;
  }

  function recordSkipped(slug: string, reason: string): void {
    coverage.skipped = [...coverage.skipped, { slug, reason }];
  }

  function markDead(entry: RepoEntry, reason: string): void {
    const prev = dead.get(entry.dbPath);
    if (!prev || prev.reason !== reason) logger.warn(`Skip observability db ${entry.dbPath}: ${reason}`);
    dead.set(entry.dbPath, { reason });
  }

  function readSchemaVersion(db: Database): number {
    const row = db.prepare("PRAGMA schema_version").get() as { schema_version?: number } | undefined;
    return typeof row?.schema_version === "number" ? row.schema_version : 0;
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
    recordSkipped(entry.repoSlug, "evicted (capacity)");
  }

  function touch(dbPath: string): void {
    const entry = lru.get(dbPath);
    if (!entry) return;
    lru.delete(dbPath);
    lru.set(dbPath, entry);
  }

  return { withAttached, getCoverage };
}

function clampMaxAttached(value: number): number {
  return Math.min(MAX_MAX_ATTACHED, Math.max(MIN_MAX_ATTACHED, Math.floor(value)));
}

function isAttachLimitError(message: string): boolean {
  return /too many attached databases/i.test(message);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
