import { watch, statSync, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { RepoEntry } from "./registry.ts";
import { makeLogEntry, type LogEntry } from "../runtime/logs.ts";

type Logger = Pick<Console, "warn" | "debug">;

export type ObservabilityWatcherOptions = {
  logger?: Logger;
  debounceMs?: number;
  triggerMaterializer?: (reason: string) => void;
  emitLog?: (entry: LogEntry) => void;
  telemetryContext?: Readonly<Record<string, unknown>>;
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
  const emitLog = options.emitLog ?? (() => {});
  const context = options.telemetryContext ?? {};
  const watched = new Map<string, WatchedRepo>();
  let stopped = false;

  function start(): void {
    if (stopped) return;
    emit("watcher.start", "info", { outcome: "started", watcher_kind: "observability", repositories: entries.length });
    for (const entry of entries) {
      if (watched.has(entry.repoSlug)) continue;
      try {
        watchRepo(entry);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "UNKNOWN") : "UNKNOWN";
        emit("watcher.attach", "warn", { outcome: "error", watcher_kind: "observability", repo_slug: entry.repoSlug, code });
        logger.warn(`[observability] watch failed (${code})`);
      }
    }
  }

  function stop(): void {
    if (stopped) return;
    emit("watcher.stop", "info", { outcome: "stopping", watcher_kind: "observability" });
    stopped = true;
    const watchedCount = watched.size;
    for (const repo of watched.values()) {
      if (repo.timer) clearTimeout(repo.timer);
      for (const watcher of repo.watchers) watcher.close();
    }
    watched.clear();
    emit("watcher.cleanup", "info", { outcome: "stopped", watcher_kind: "observability", watched: watchedCount });
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
    emit("watcher.attach", "info", { outcome: "attached", watcher_kind: "observability", repo_slug: entry.repoSlug });
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
      emit("watcher.trigger", "info", { outcome: "changed", watcher_kind: "observability", repo_slug: repoSlug });
      triggerMaterializer?.(`obs:${repoSlug}`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "UNKNOWN") : "UNKNOWN";
      emit("watcher.skip", "debug", { outcome: "missing", watcher_kind: "observability", repo_slug: repoSlug, code });
      logger.debug?.(`[observability] db missing (${code})`);
    }
  }

  function mtimeOrZero(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; }
  }

  return { start, stop };

  function emit(event: string, level: "debug" | "info" | "warn", data: Record<string, unknown>): void {
    emitLog(makeLogEntry("watcher", event, level, undefined, { ...context, ...data }));
  }
}
