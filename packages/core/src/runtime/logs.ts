export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogComponent =
  | "poller"
  | "watcher"
  | "dolt"
  | "ws"
  | "api"
  | "breaker"
  | "system"
  | "migration"
  | "store"
  | "drawer"
  | "explore"
  | "cockpit"
  | "logger"
  | "materializer";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  component: LogComponent;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
};

export interface LogPublisher {
  publish(entry: LogEntry): void;
}

export function makeLogEntry(component: LogComponent, event: string, level: LogLevel, msg?: string, data?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, component, event, msg, data };
}
