import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogLevel } from "./logs.ts";

export const LOG_RING_SIZE = 5000;
export const LOG_DEFAULT_LEVEL: LogLevel = "info";
export const LOG_RETENTION_DAYS = 7;

export type LogFilter = Partial<Pick<LogEntry, "level" | "component" | "event">>;
export type LogListener = (entry: LogEntry) => void;
export type RuntimeLogPublisher = (entry: LogEntry) => void;
export type LogWriteErrorHandler = (error: unknown) => void;

export type LoggerRuntimeOptions = {
  readonly diskDir: string;
  readonly fallbackDiskDir?: string;
  readonly legacyLogDir?: string;
  readonly legacyLinkName?: string;
  readonly ringSize?: number;
  readonly retentionDays?: number;
  readonly defaultLevel?: LogLevel;
  readonly publisher?: RuntimeLogPublisher | null;
  readonly onWriteError?: LogWriteErrorHandler;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type Listener = {
  readonly filter?: LogFilter;
  readonly fn: LogListener;
};

export type LoggerRuntime = ReturnType<typeof createLoggerRuntime>;

export function createLoggerRuntime(options: LoggerRuntimeOptions) {
  const ringSizeLimit = options.ringSize ?? LOG_RING_SIZE;
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  const ring = new Array<LogEntry>(ringSizeLimit);
  const listeners = new Set<Listener>();
  let ringStart = 0;
  let ringSize = 0;
  let diskEnabled = true;
  let logLevel = options.defaultLevel ?? LOG_DEFAULT_LEVEL;
  let publisher: RuntimeLogPublisher | null = options.publisher ?? null;
  let writeChain: Promise<void> = Promise.resolve();
  let lastCleanupDay = "";
  let logStorageReady = false;

  function setRealtimePublisher(nextPublisher: RuntimeLogPublisher | null): void {
    publisher = nextPublisher;
  }

  function emit(entry: LogEntry): void {
    pushRing(entry);
    if (diskEnabled) queueDiskWrite(entry);
    if (publisher && shouldBroadcast(entry.level)) publisher(entry);
  }

  function getRing(): LogEntry[] {
    const items: LogEntry[] = [];
    for (let i = 0; i < ringSize; i += 1) items.push(ring[(ringStart + i) % ringSizeLimit]);
    return items;
  }

  function subscribe(filter: LogFilter | undefined, fn: LogListener): () => void {
    const listener = { filter, fn };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setDiskEnabled(enabled: boolean): void {
    diskEnabled = enabled;
  }

  function setLogLevel(level: LogLevel): void {
    logLevel = level;
  }

  function ensureLogStorage(): string {
    if (logStorageReady) return options.diskDir;
    mkdirSync(options.diskDir, { recursive: true });
    ensureLegacyLink();
    logStorageReady = true;
    return options.diskDir;
  }

  function getLogDiskDir(): string {
    return options.diskDir;
  }

  function pushRing(entry: LogEntry): void {
    if (ringSize < ringSizeLimit) {
      ring[(ringStart + ringSize) % ringSizeLimit] = entry;
      ringSize += 1;
    } else {
      ring[ringStart] = entry;
      ringStart = (ringStart + 1) % ringSizeLimit;
    }
    notifyListeners(entry);
  }

  function notifyListeners(entry: LogEntry): void {
    for (const listener of listeners) {
      if (!matchesFilter(entry, listener.filter)) continue;
      listener.fn(entry);
    }
  }

  function shouldBroadcast(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[logLevel];
  }

  function queueDiskWrite(entry: LogEntry): void {
    writeChain = writeChain
      .then(async () => {
        await ensureDiskDir();
        await cleanupRetentionIfNeeded();
        await appendFile(currentLogPath(entry.ts), `${JSON.stringify(entry)}\n`);
      })
      .catch((error) => {
        options.onWriteError?.(error);
        writeChain = Promise.resolve();
      });
  }

  function currentLogPath(ts = new Date().toISOString()): string {
    return join(activeLogDir(), `${ts.slice(0, 10)}.jsonl`);
  }

  function activeLogDir(): string {
    try {
      return ensureLogStorage();
    } catch {
      return options.fallbackDiskDir ?? "./logs";
    }
  }

  async function ensureDiskDir(): Promise<void> {
    mkdirSync(activeLogDir(), { recursive: true });
  }

  async function cleanupRetentionIfNeeded(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastCleanupDay) return;
    lastCleanupDay = day;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(activeLogDir())) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(activeLogDir(), name);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    }
  }

  function ensureLegacyLink(): void {
    if (!options.legacyLogDir || !options.legacyLinkName) return;
    if (!existsSync(options.legacyLogDir)) return;
    const legacyLink = join(options.diskDir, options.legacyLinkName);
    if (existsSync(legacyLink)) return;
    try {
      symlinkSync(options.legacyLogDir, legacyLink, "dir");
    } catch {}
  }

  return { emit, getRing, subscribe, setDiskEnabled, setLogLevel, setRealtimePublisher, ensureLogStorage, getLogDiskDir };
}

function matchesFilter(entry: LogEntry, filter: LogFilter | undefined): boolean {
  if (filter?.level && filter.level !== entry.level) return false;
  if (filter?.component && filter.component !== entry.component) return false;
  if (filter?.event && filter.event !== entry.event) return false;
  return true;
}
