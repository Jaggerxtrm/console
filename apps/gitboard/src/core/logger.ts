import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogComponent, LogEntry, LogLevel } from "../types/log.ts";
import type { ChannelRegistry } from "../api/ws/channels.ts";

const LOG_RING_SIZE = 5000;
const LOG_DEFAULT_LEVEL: LogLevel = "info";
const LOG_DISK_DIR = process.env.LOG_DIR ?? "/data/logs";
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
  writeChain = writeChain.then(async () => {
    await ensureDiskDir();
    await cleanupRetentionIfNeeded();
    await appendFile(currentLogPath(), `${JSON.stringify(entry)}\n`);
  });
}

function currentLogPath(): string { return join(activeLogDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`); }

function activeLogDir(): string {
  try {
    mkdirSync(LOG_DISK_DIR, { recursive: true });
    return LOG_DISK_DIR;
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
