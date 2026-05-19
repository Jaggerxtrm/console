export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogComponent = "poller" | "watcher" | "dolt" | "ws" | "api" | "breaker" | "system";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  component: LogComponent;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
};
