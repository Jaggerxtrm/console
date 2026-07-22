import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { createRuntimeHostDescriptor, type RuntimeHostDescriptor } from "../../../../packages/core/src/runtime/host.ts";
import { type ConsoleDatabaseBootstrap } from "./database.ts";
import { redactHomePath, resolveDataDir, type DataDirResolution } from "./data-dir.ts";
import { createHostLogger, type HostLogger } from "./log.ts";
import { readStaticAsset } from "./static.ts";

export const CONSOLE_HOST_OWNER = "apps/console" as const;

const DEFAULT_CONSOLE_DIST_DIR = fileURLToPath(new URL("../../dist/dashboard/console", import.meta.url));

/**
 * Lifecycle hook contract consumed by later migration phases. The host invokes
 * each hook at a fixed point so API routes (2+), materializer (3), WebSocket
 * (4), and terminal (6) can move later without changing the host boundary.
 * All hooks are optional; Phase 1 wires none by default.
 */
export interface ConsoleHostHooks {
  /** Mount API routers onto the Hono app; return mounted route prefixes. */
  mountRoutes?: (app: Hono) => readonly string[] | void;
  /** Attach the realtime upgrade handler once the HTTP listener is bound. */
  attachWebSocket?: (server: Bun.Server<undefined>) => void;
  /** Attach the terminal bridge once the HTTP listener is bound. */
  attachTerminal?: (server: Bun.Server<undefined>) => void;
  /** Start background workers (materializer/scanner) before serving. */
  startBackground?: () => void | Promise<void>;
  /** Stop background workers before the listener is released. */
  stopBackground?: () => void | Promise<void>;
}

export interface ConsoleHostOptions {
  port?: number;
  hostname?: string;
  consoleDistDir?: string;
  dataDir?: DataDirResolution;
  database?: ConsoleDatabaseBootstrap;
  logger?: HostLogger;
  hooks?: ConsoleHostHooks;
}

export interface ConsoleHostRunning {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly server: Bun.Server<undefined>;
  stop(): Promise<void>;
}

export interface ConsoleHost {
  readonly app: Hono;
  readonly descriptor: RuntimeHostDescriptor<null, null, null>;
  readonly dataDir: DataDirResolution;
  readonly consoleDistDir: string;
  readonly database: ConsoleDatabaseBootstrap | null;
  start(): Promise<ConsoleHostRunning>;
}

async function serveIndex(distDir: string): Promise<Response> {
  const index = await readStaticAsset(distDir, "index.html");
  if (!index) {
    return Response.json(
      { status: "error", service: "console-host", error: "console-dist-missing" },
      { status: 503 },
    );
  }
  return new Response(index.body, {
    status: 200,
    headers: { "content-type": index.contentType, "cache-control": "no-cache" },
  });
}

function buildApp(consoleDistDir: string, hooks: ConsoleHostHooks): { app: Hono; mountedApiRoutes: readonly string[] } {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "console-host", owner: CONSOLE_HOST_OWNER }));

  app.get("/", (c) => c.redirect("/console"));

  // Legacy Gitboard routes are permanently retired to /console. Fixed literal
  // target only — never derive the Location from the request, so query strings
  // and fragments cannot produce an open redirect.
  app.get("/gitboard", (c) => c.redirect("/console", 308));
  app.get("/gitboard/*", (c) => c.redirect("/console", 308));

  app.get("/console", async () => serveIndex(consoleDistDir));

  app.get("/console/*", async (c) => {
    const relativePath = c.req.path.replace(/^\/console\/?/, "");
    if (relativePath) {
      const asset = await readStaticAsset(consoleDistDir, relativePath);
      if (asset) {
        return new Response(asset.body, {
          status: 200,
          headers: {
            "content-type": asset.contentType,
            "cache-control": relativePath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          },
        });
      }
    }
    return serveIndex(consoleDistDir);
  });

  const mounted = hooks.mountRoutes?.(app);
  const mountedApiRoutes = Array.isArray(mounted) ? mounted : [];

  return { app, mountedApiRoutes };
}

/**
 * Creates the console production host. Construction is pure: no listener is
 * bound until `start()`, so tests can exercise routing via `app.request()` and
 * smoke can bind an ephemeral 127.0.0.1 port then release it deterministically.
 */
export function createConsoleHost(options: ConsoleHostOptions = {}): ConsoleHost {
  const logger = options.logger ?? createHostLogger();
  const dataDir = options.dataDir ?? resolveDataDir();
  const consoleDistDir = options.consoleDistDir ?? process.env.CONSOLE_DIST_DIR?.trim() ?? DEFAULT_CONSOLE_DIST_DIR;
  const hooks = options.hooks ?? {};
  const database = options.database ?? null;

  const { app, mountedApiRoutes } = buildApp(consoleDistDir, hooks);

  const descriptor = createRuntimeHostDescriptor<null, null, null>({
    owner: CONSOLE_HOST_OWNER,
    storeDb: null,
    stateDb: null,
    registry: null,
    materializer: null,
    mountedRoutes: ["/health", "/console", ...mountedApiRoutes],
    capabilities: ["http-api", "static-dashboard"],
    staticServiceParity: [],
  });

  logger.debug("host.configured", {
    owner: CONSOLE_HOST_OWNER,
    dataDirSource: dataDir.source,
    consoleDistDir: redactHomePath(consoleDistDir),
    mountedRoutes: descriptor.mountedRoutes,
  });

  async function rollbackBackground(): Promise<void> {
    try {
      await hooks.stopBackground?.();
    } catch (error) {
      logger.warn("host.background_rollback_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    app,
    descriptor,
    dataDir,
    consoleDistDir,
    database,
    start: async () => {
      database?.ensureDataDir();
      await hooks.startBackground?.();

      let server: Bun.Server<undefined>;
      try {
        server = Bun.serve({
          hostname: options.hostname ?? "127.0.0.1",
          port: options.port ?? 0,
          idleTimeout: 30,
          fetch: (request) => app.fetch(request),
        });
      } catch (error) {
        await rollbackBackground();
        throw error;
      }

      try {
        hooks.attachWebSocket?.(server);
        hooks.attachTerminal?.(server);
      } catch (error) {
        server.stop(true);
        await rollbackBackground();
        throw error;
      }

      const port = server.port ?? 0;
      const hostname = server.hostname ?? options.hostname ?? "127.0.0.1";
      let stopped = false;
      return {
        port,
        hostname,
        url: `http://${hostname}:${port}`,
        server,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try {
            await hooks.stopBackground?.();
          } finally {
            server.stop(true);
          }
        },
      };
    },
  };
}
