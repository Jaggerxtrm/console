import { watch, statSync, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { RepoEntry } from "./registry.ts";
import { getCurrentMaterializer } from "../../api/server.ts";

type Logger = Pick<Console, "warn" | "debug">;

type WatchOptions = {
  logger?: Logger;
  debounceMs?: number;
};

type WatchedRepo = {
  entry: RepoEntry;
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  lastMtimeMs: number;
};

const DEFAULT_DEBOUNCE_MS = 200;

export function createObservabilityWatcher(entries: readonly RepoEntry[], options: WatchOptions = {}) {
  const logger = options.logger ?? console;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
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
    const watcher = watch(parentDir, { persistent: false }, (_eventType, filename) => {
      if (filename !== basename(entry.dbPath)) return;
      scheduleBump(entry);
    });
    const fileWatcher = watch(entry.dbPath, { persistent: false }, () => scheduleBump(entry));

    watched.set(entry.repoSlug, {
      entry,
      watchers: [watcher, fileWatcher],
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
      const stat = statSync(repo.entry.dbPath);
      if (stat.mtimeMs <= repo.lastMtimeMs) return;
      repo.lastMtimeMs = stat.mtimeMs;
      const materializer = getCurrentMaterializer();
      materializer?.trigger(`obs:${repoSlug}`);
    } catch (error) {
      logger.debug?.(`[observability] db missing for ${repo.entry.dbPath}: ${stringifyError(error)}`);
    }
  }

  return { start, stop };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
