import { isAbsolute, join, resolve } from "node:path";
import type { ChannelRegistry } from "../api/ws/channels.ts";
import { createLoggerRuntime } from "../../../../packages/core/src/runtime/server.ts";
import {
  makeLogEntry,
  LOG_DEFAULT_LEVEL,
  LOG_RETENTION_DAYS as DEFAULT_LOG_RETENTION_DAYS,
  LOG_RING_SIZE,
  type LogEntry,
  type LogLevel,
} from "../../../../packages/core/src/runtime/index.ts";

export { makeLogEntry, LOG_DEFAULT_LEVEL, LOG_RING_SIZE };
export type { EventType } from "./observability/event-types.ts";

const HOME_DIR = resolve(process.env.HOME ?? ".");
const LEGACY_LOG_DIR = join(HOME_DIR, ".agent-forge", "logs");
const XTRM_LOG_DIR = join(HOME_DIR, ".xtrm", "logs");
const ENV_LOG_DISK_DIR = process.env.LOG_DIR?.trim() || process.env.GITBOARD_LOG_DIR?.trim();
const LOG_DISK_DIR = ENV_LOG_DISK_DIR ? resolveEnvLogDir(ENV_LOG_DISK_DIR) : XTRM_LOG_DIR;
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? DEFAULT_LOG_RETENTION_DAYS);

const logger = createLoggerRuntime({
  diskDir: LOG_DISK_DIR,
  legacyLogDir: LOG_DISK_DIR === XTRM_LOG_DIR ? LEGACY_LOG_DIR : undefined,
  legacyLinkName: LOG_DISK_DIR === XTRM_LOG_DIR ? "legacy" : undefined,
  retentionDays: LOG_RETENTION_DAYS,
  onWriteError: (error) => console.error("[gitboard] log write failed", error),
});

export function setRealtimePublisher(nextRegistry: ChannelRegistry | null): void {
  logger.setRealtimePublisher(nextRegistry ? (entry) => nextRegistry.publish("system", "system:log", entry, entry.ts) : null);
}

export function emit(entry: LogEntry): void { logger.emit(entry); }
export function getRing(): LogEntry[] { return logger.getRing(); }
export function subscribe(filter: Partial<Pick<LogEntry, "level" | "component" | "event">> | undefined, fn: (entry: LogEntry) => void): () => void {
  return logger.subscribe(filter, fn);
}
export function setDiskEnabled(enabled: boolean): void { logger.setDiskEnabled(enabled); }
export function setLogLevel(level: LogLevel): void { logger.setLogLevel(level); }
export function ensureLogStorage(): string { return logger.ensureLogStorage(); }
export function emitLogPath(): void {
  emit(makeLogEntry("logger", "log.path", "info", undefined, { path: ensureLogStorage() }));
}
export function getLogDiskDir(): string { return logger.getLogDiskDir(); }

export { LOG_DISK_DIR, LOG_RETENTION_DAYS };

function resolveEnvLogDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(dir);
}
