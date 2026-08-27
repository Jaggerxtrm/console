import { Hono } from "hono";

const DEFAULT_EVENT_LIMIT = 240;
const MIN_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 500;
const COMMAND_TIMEOUT_MS = 3_500;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export interface RuntimeObservabilityRunner {
  run(args: readonly string[]): Promise<string>;
}

export interface RuntimeObservabilityRouterOptions {
  readonly runner?: RuntimeObservabilityRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

type SourceHealth = {
  status: "ok" | "degraded";
  latency_ms: number;
  error?: string;
};

type SourceResult<T> = {
  data: T | null;
  health: SourceHealth;
};

export function createRuntimeObservabilityRouter(options: RuntimeObservabilityRouterOptions = {}): Hono {
  const app = new Hono();
  const runner = options.runner ?? createXtmuxRunner(options.env ?? process.env);
  const now = options.now ?? Date.now;

  app.get("/overview", async (c) => {
    const eventLimit = clampEventLimit(c.req.query("event_limit"));
    const [topology, journal] = await Promise.all([
      readJsonSource<Record<string, unknown>>(runner, ["topology", "--json"], isTopology),
      readJsonSource<unknown[]>(runner, ["log-tail", String(eventLimit), "--json"], Array.isArray),
    ]);

    return c.json({
      schema_version: "xtrm.console.runtime-observability.v1",
      generated_at_ms: now(),
      topology: topology.data,
      events: journal.data ?? [],
      source_health: {
        topology: topology.health,
        journal: journal.health,
      },
    });
  });

  return app;
}

export function clampEventLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_EVENT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_EVENT_LIMIT;
  return Math.max(MIN_EVENT_LIMIT, Math.min(MAX_EVENT_LIMIT, Math.trunc(parsed)));
}

function createXtmuxRunner(env: NodeJS.ProcessEnv): RuntimeObservabilityRunner {
  const binary = env.XTMUX_BIN?.trim() || "xtmux";
  return {
    async run(args: readonly string[]): Promise<string> {
      const proc = Bun.spawn([binary, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        if (exitCode !== 0) {
          throw new Error(compactError(stderr || `${binary} exited ${exitCode}`));
        }
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
          throw new Error(`xtmux output exceeded ${MAX_STDOUT_BYTES} bytes`);
        }
        return stdout;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readJsonSource<T>(
  runner: RuntimeObservabilityRunner,
  args: readonly string[],
  validate: (value: unknown) => boolean,
): Promise<SourceResult<T>> {
  const startedAt = performance.now();
  try {
    const raw = await runner.run(args);
    const parsed: unknown = JSON.parse(raw);
    if (!validate(parsed)) throw new Error("xtmux returned an unexpected JSON shape");
    return {
      data: parsed as T,
      health: { status: "ok", latency_ms: Math.round(performance.now() - startedAt) },
    };
  } catch (error) {
    return {
      data: null,
      health: {
        status: "degraded",
        latency_ms: Math.round(performance.now() - startedAt),
        error: compactError(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

function isTopology(value: unknown): boolean {
  return isObject(value) && Array.isArray((value as { sessions?: unknown }).sessions);
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactError(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}…` : compact;
}
