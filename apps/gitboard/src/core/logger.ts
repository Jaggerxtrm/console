import { mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogComponent, LogEntry, LogLevel } from "../types/log.ts";
import type { ChannelRegistry } from "../api/ws/channels.ts";
export type { EventType } from "./observability/event-types.ts";

const LOG_RING_SIZE = 5000;
const LOG_DEFAULT_LEVEL: LogLevel = "info";
const HOME_DIR = process.env.HOME ?? ".";
const LEGACY_LOG_DIR = join(HOME_DIR, ".agent-forge", "logs");
const XTRM_LOG_DIR = join(HOME_DIR, ".xtrm", "logs");
const LOG_DISK_DIR = process.env.LOG_DIR || process.env.GITBOARD_LOG_DIR || XTRM_LOG_DIR;
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 7);
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let ring: LogEntry[] = new Array<LogEntry>(LOG_RING_SIZE);
let ringStart = 0;
let ringSize = 0;
let diskEnabled = true;
let logLevel: LogLevel = LOG_DEFAULT_LEVEL;
let registry: ChannelRegistry | null = null;
let writeChain: Promise<void> = Promise.resolve();
let lastCleanupDay = "";
let logStorageReady = false;

export function setRealtimePublisher(nextRegistry: ChannelRegistry | null): void {
  registry = nextRegistry;
}

export function emit(entry: LogEntry): void {
  pushRing(entry);
  if (diskEnabled) queueDiskWrite(entry);
  if (registry && shouldBroadcast(entry.level)) registry.publish("system", "system:log", entry, entry.ts);
}

export function getRing(): LogEntry[] {
  const items: LogEntry[] = [];
  for (let i = 0; i < ringSize; i += 1) items.push(ring[(ringStart + i) % LOG_RING_SIZE]);
  return items;
}

export function subscribe(filter: Partial<Pick<LogEntry, "level" | "component" | "event">> | undefined, fn: (entry: LogEntry) => void): () => void {
  const listener = { filter, fn };
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDiskEnabled(enabled: boolean): void { diskEnabled = enabled; }
export function setLogLevel(level: LogLevel): void { logLevel = level; }
export function ensureLogStorage(): string {
  if (logStorageReady) return LOG_DISK_DIR;
  mkdirSync(LOG_DISK_DIR, { recursive: true });
  if (LOG_DISK_DIR === XTRM_LOG_DIR && existsSync(LEGACY_LOG_DIR)) {
    mkdirSync(XTRM_LOG_DIR, { recursive: true });
    const legacyLink = join(XTRM_LOG_DIR, "legacy");
    if (!existsSync(legacyLink)) {
      try {
        symlinkSync(LEGACY_LOG_DIR, legacyLink, "dir");
      } catch {}
    }
  }
  logStorageReady = true;
  return LOG_DISK_DIR;
}

export function emitLogPath(): void {
  emit(makeLogEntry("logger", "log.path", "info", undefined, { path: ensureLogStorage() }));
}

export function getLogDiskDir(): string { return LOG_DISK_DIR; }

const listeners = new Set<{ filter?: Partial<Pick<LogEntry, "level" | "component" | "event">>; fn: (entry: LogEntry) => void }>();

function pushRing(entry: LogEntry): void {
  if (ringSize < LOG_RING_SIZE) {
    ring[(ringStart + ringSize) % LOG_RING_SIZE] = entry;
    ringSize += 1;
  } else {
    ring[ringStart] = entry;
    ringStart = (ringStart + 1) % LOG_RING_SIZE;
  }
  for (const listener of listeners) {
    const filter = listener.filter;
    if (filter?.level && filter.level !== entry.level) continue;
    if (filter?.component && filter.component !== entry.component) continue;
    if (filter?.event && filter.event !== entry.event) continue;
    listener.fn(entry);
  }
}

function shouldBroadcast(level: LogLevel): boolean { return LEVEL_ORDER[level] >= LEVEL_ORDER[logLevel]; }

function queueDiskWrite(entry: LogEntry): void {
  writeChain = writeChain
    .then(async () => {
      await ensureDiskDir();
      await cleanupRetentionIfNeeded();
      await appendFile(currentLogPath(), `${JSON.stringify(entry)}\n`);
    })
    .catch((error) => {
      console.error("[gitboard] log write failed", error);
      writeChain = Promise.resolve();
    });
}

function currentLogPath(): string { return join(activeLogDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`); }

function activeLogDir(): string {
  try {
    return ensureLogStorage();
  } catch {
    return "./logs";
  }
}

async function ensureDiskDir(): Promise<void> { mkdirSync(activeLogDir(), { recursive: true }); }

async function cleanupRetentionIfNeeded(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastCleanupDay) return;
  lastCleanupDay = day;
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(activeLogDir())) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(activeLogDir(), name);
    if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
  }
}

export function makeLogEntry(component: LogComponent, event: string, level: LogLevel, msg?: string, data?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, component, event, msg, data };
}

export { LOG_RING_SIZE, LOG_DEFAULT_LEVEL, LOG_DISK_DIR, LOG_RETENTION_DAYS };
