import { watch, statSync, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { RepoEntry } from "./registry.ts";

type Logger = Pick<Console, "warn" | "debug">;

export type ObservabilityWatcherOptions = {
  logger?: Logger;
  debounceMs?: number;
  triggerMaterializer?: (reason: string) => void;
};

type WatchedRepo = {
  entry: RepoEntry;
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  lastMtimeMs: number;
};

const DEFAULT_DEBOUNCE_MS = 200;

export function createObservabilityWatcher(entries: readonly RepoEntry[], options: ObservabilityWatcherOptions = {}) {
  const logger = options.logger ?? console;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const triggerMaterializer = options.triggerMaterializer;
  const watched = new Map<string, WatchedRepo>();
  let stopped = false;

  function start(): void {
    if (stopped) return;
    for (const entry of entries) {
      if (watched.has(entry.repoSlug)) continue;
      try {
        watchRepo(entry);
      } catch (error) {
        logger.warn(`[observability] watch failed for ${entry.dbPath}: ${stringifyError(error)}`);
      }
    }
  }

  function stop(): void {
    stopped = true;
    for (const repo of watched.values()) {
      if (repo.timer) clearTimeout(repo.timer);
      for (const watcher of repo.watchers) watcher.close();
    }
    watched.clear();
  }

  function watchRepo(entry: RepoEntry): void {
    const parentDir = dirname(entry.dbPath);
    const dbName = basename(entry.dbPath);
    // SQLite WAL mode writes hit -wal first; main .db only updates on checkpoint (seconds-to-minutes lag).
    // Watch the main file AND the WAL sidecar so sp's writes are visible without waiting for checkpoint.
    const walName = `${dbName}-wal`;
    const shmName = `${dbName}-shm`;
    const watchers: FSWatcher[] = [];
    watchers.push(watch(parentDir, { persistent: false }, (_eventType, filename) => {
      if (filename === dbName || filename === walName || filename === shmName) scheduleBump(entry);
    }));
    // Direct file watches are best-effort — they may fail for sidecars that don't exist yet at boot.
    for (const path of [entry.dbPath, `${entry.dbPath}-wal`, `${entry.dbPath}-shm`]) {
      try { watchers.push(watch(path, { persistent: false }, () => scheduleBump(entry))); } catch { /* sidecar may not exist yet */ }
    }

    watched.set(entry.repoSlug, {
      entry,
      watchers,
      timer: null,
      lastMtimeMs: entry.mtimeMs,
    });
  }

  function scheduleBump(entry: RepoEntry): void {
    const repo = watched.get(entry.repoSlug);
    if (!repo || stopped) return;

    if (repo.timer) clearTimeout(repo.timer);
    repo.timer = setTimeout(() => flush(entry.repoSlug), debounceMs);
  }

  function flush(repoSlug: string): void {
    const repo = watched.get(repoSlug);
    if (!repo || stopped) return;
    repo.timer = null;

    try {
      // Use the max mtime across .db + .db-wal as the "has-changed" signal — WAL writes update the sidecar,
      // not the main file, so checking .db alone misses every uncheckpointed write.
      const mainMtime = statSync(repo.entry.dbPath).mtimeMs;
      const walMtime = mtimeOrZero(`${repo.entry.dbPath}-wal`);
      const observed = Math.max(mainMtime, walMtime);
      if (observed <= repo.lastMtimeMs) return;
      repo.lastMtimeMs = observed;
      triggerMaterializer?.(`obs:${repoSlug}`);
    } catch (error) {
      logger.debug?.(`[observability] db missing for ${repo.entry.dbPath}: ${stringifyError(error)}`);
    }
  }

  function mtimeOrZero(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; }
  }

  return { start, stop };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
