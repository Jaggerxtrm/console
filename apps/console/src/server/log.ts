export type HostLogLevel = "debug" | "info" | "warn" | "error";

export type HostLogFields = Readonly<Record<string, unknown>>;

export interface HostLogEntry {
  readonly ts: string;
  readonly level: HostLogLevel;
  readonly component: "console-host";
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface HostLogger {
  debug(event: string, fields?: HostLogFields): void;
  info(event: string, fields?: HostLogFields): void;
  warn(event: string, fields?: HostLogFields): void;
  error(event: string, fields?: HostLogFields): void;
}

export interface CreateHostLoggerOptions {
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_RANK: Record<HostLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinLevel(): HostLogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

/**
 * Structured JSON logger for the console host boundary. Emits one JSON line per
 * event. Callers must only pass non-secret fields (ports, paths, owners,
 * counts); never tokens, credentials, or raw request bodies.
 */
export function createHostLogger(options: CreateHostLoggerOptions = {}): HostLogger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const minRank = LEVEL_RANK[resolveMinLevel()];

  function emit(level: HostLogLevel, event: string, fields?: HostLogFields): void {
    if (LEVEL_RANK[level] < minRank) return;
    // Caller fields spread first so the reserved envelope keys below stay
    // authoritative; a hook can never overwrite ts/level/component/event.
    const entry: HostLogEntry = {
      ...fields,
      ts: now().toISOString(),
      level,
      component: "console-host",
      event,
    };
    sink(JSON.stringify(entry));
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
