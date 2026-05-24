import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "./routes/github.ts";
import { createInternalDoltHealthRouter } from "./routes/internal-dolt-health.ts";
import { createInternalLogsRouter } from "./routes/internal-logs.ts";
import { createInternalVerifyRouter } from "./routes/internal-verify.ts";
import { setRealtimePublisher, emit, makeLogEntry } from "../core/logger.ts";
import { beadsRoutes } from "../../../beadboard/src/api/routes/beads.ts";
import { createSpecialistsRouter } from "./routes/specialists.ts";
import { createObservabilityRouter } from "./routes/observability.ts";
import { createGraphRouter } from "./routes/graph.ts";
import { createShellRouter } from "./routes/shell.ts";
import { createTerminalRouter } from "./routes/terminal.ts";
import { ChannelRegistry } from "./ws/channels.ts";
import { WsHandler } from "./ws/handler.ts";
import { Materializer } from "../core/materializer/index.ts";
import { BeadsChangeWatcher } from "../../../beadboard/src/core/beads-change-watcher.ts";
import { createObservabilityWatcher } from "../server/observability/watcher.ts";
import { onBump as onObservabilityBump } from "../server/observability/epoch.ts";
import { listRepos } from "../server/observability/registry.ts";
import { getShellProviderStatus, isAllowedShellWebSocketOrigin, isShellWebSocketPath, isVerifiedShellAdminRequest, shouldRejectShellWebSocket } from "../core/shell-provider-policy.ts";
import { createTerminalProviderRegistry } from "./terminal/provider-registry.ts";
import { TerminalBridge } from "./terminal/bridge.ts";

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

let currentRegistry: ChannelRegistry | null = null;
let currentWatcher: BeadsChangeWatcher | null = null;
let currentObservabilityWatcher: ReturnType<typeof createObservabilityWatcher> | null = null;
let currentSpecialistsBumpUnsubscribe: (() => void) | null = null;

export function getCurrentRegistry(): ChannelRegistry | null {
  return currentRegistry;
}

const repoRoot = process.cwd().endsWith("/apps/gitboard") ? join(process.cwd(), "../..") : process.cwd();
const gitboardDist = join(repoRoot, "apps/gitboard/dist/dashboard");
// beadboardDist removed (forge-5w9.9) — frontend deprecated; /beadboard redirects to /gitboard.

export function createApp(db: Database, xtrmDb?: Database): {
  app: Hono;
  registry: ChannelRegistry;
  wsHandler: WsHandler;
  materializer: Materializer | null;
} {
  const app = new Hono();
  const registry = new ChannelRegistry();
  currentRegistry = registry;
  const materializer = xtrmDb ? new Materializer(xtrmDb, registry) : null;
  const wsHandler = new WsHandler(registry);
  setRealtimePublisher(registry);
  currentWatcher = new BeadsChangeWatcher({ registry });
  currentWatcher.start();
  currentObservabilityWatcher?.stop();
  currentObservabilityWatcher = createObservabilityWatcher(listRepos());
  currentObservabilityWatcher.start();

  // Bridge observability epoch bumps (raised by the watcher when an observability
  // db file changes) onto the WS bus so the dashboard's graph specialist overlay
  // and the specialists drawer can refetch immediately instead of polling
  // (forge-7cyq). Mirrors the BeadsChangeWatcher / github-poller publish pattern.
  currentSpecialistsBumpUnsubscribe?.();
  currentSpecialistsBumpUnsubscribe = onObservabilityBump((repoSlug, epoch) => {
    registry.publish(
      "specialists:activity",
      "specialists:sync_hint",
      { reason: "epoch_bump", repo_slug: repoSlug },
      String(epoch),
    );
  });

  app.use("*", cors());
  app.use("*", async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } catch (error) {
      emit(makeLogEntry("api", "request.error", "error", "request failed", { path: c.req.path, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    } finally {
      const ms = Math.round(performance.now() - start);
      if (c.req.path.startsWith("/api/github") || c.req.path.startsWith("/api/console") || c.req.path.startsWith("/api/beads")) {
        emit(makeLogEntry("api", "request.timing", "info", undefined, { path: c.req.path, ms, status: c.res.status }));
      }
      if (ms > 500) emit(makeLogEntry("api", "request.slow", "warn", "slow request", { path: c.req.path, ms }));
      if (c.res.status >= 400) emit(makeLogEntry("api", "request.error", c.res.status >= 500 ? "error" : "warn", "request failed", { path: c.req.path, status: c.res.status }));
    }
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // API routes
  app.route("/api/github", createGithubRouter(db, registry));
  app.route("/api/beads", beadsRoutes);
  app.route("/api/specialists", createSpecialistsRouter());
  app.route("/api/console/observability", createObservabilityRouter());
  app.route("/api/console/graph", createGraphRouter());
  app.route("/api/console/shell", createShellRouter());
  app.route("/api/console/terminal", createTerminalRouter());
  app.route("/api/internal", createInternalDoltHealthRouter());
  app.route("/api/internal", createInternalLogsRouter());
  app.route("/api/internal", createInternalVerifyRouter());

  // Serve built dashboards in production
  if (process.env.NODE_ENV === "production") {
    // Gitboard - serve assets and SPA
    app.get("/gitboard/assets/*", async (c) => {
      const path = c.req.path.replace("/gitboard", "/gitboard");
      const file = Bun.file(join(gitboardDist, path));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": contentType(path) } });
      return c.notFound();
    });

    app.get("/gitboard", async (c) => {
      const file = Bun.file(join(gitboardDist, "gitboard/index.html"));
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    });

    app.get("/gitboard/*", async (c) => {
      const file = Bun.file(join(gitboardDist, "gitboard/index.html"));
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    });

    // Beadboard frontend deprecated (forge-5w9.9) — unified into gitboard's IDE shell.
    // /beadboard and /beadboard/* now redirect to gitboard. Backend routes at
    // /api/beads/* still come from beadboard's source via beadsRoutes above.
    app.get("/beadboard", (c) => c.redirect("/gitboard"));
    app.get("/beadboard/*", (c) => c.redirect("/gitboard"));

    // Root redirects to gitboard
    app.get("/", (c) => c.redirect("/gitboard"));
  }

  return { app, registry, wsHandler, materializer };
}

export function startServer(db: Database, xtrmDb?: Database, options: ServerOptions = {}): void {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

  const { app, wsHandler } = createApp(db, xtrmDb);
  const terminalBridge = new TerminalBridge(createTerminalProviderRegistry(process.env));

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        const path = new URL(req.url).pathname;
        if (isShellWebSocketPath(path)) {
          if (!isAllowedShellWebSocketOrigin(req.headers.get("origin"), req.headers.get("host"), process.env)) {
            return new Response(JSON.stringify({ error: "shell websocket origin denied" }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          const isVerifiedAdmin = isVerifiedShellAdminRequest(req.headers, process.env);
          const status = getShellProviderStatus(process.env, { isVerifiedAdmin });
          if (shouldRejectShellWebSocket(path, status)) {
            return new Response(JSON.stringify({ error: status.disabledReason }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          return terminalBridge.handleUpgrade(req, server, path, { isVerifiedAdmin });
        }
        const upgraded = server.upgrade(req, { data: { path } } as never);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const path = (ws.data as { path?: string } | undefined)?.path ?? "";
        if (path.startsWith("/api/console/terminal/ws")) {
          const pendingId = (ws.data as { connId?: string } | undefined)?.connId;
          const id = terminalBridge.connect((data) => ws.send(data), pendingId);
          (ws as typeof ws & { connId: string }).connId = id;
          return;
        }
        const id = wsHandler.connect({
          send: (data) => ws.send(data),
          close: () => ws.close(),
        });
        (ws as typeof ws & { connId: string }).connId = id;
        ws.send(JSON.stringify({ type: "connected", id }));
      },
      message(ws, msg) {
        const path = (ws.data as { path?: string } | undefined)?.path ?? "";
        if (path.startsWith("/api/console/terminal/ws")) {
          void terminalBridge.handleMessage((ws as typeof ws & { connId?: string }).connId ?? "terminal-0", msg.toString());
          return;
        }
        const id = (ws as typeof ws & { connId: string }).connId;
        if (id) wsHandler.handleMessage(id, msg.toString());
      },
      close(ws) {
        const path = (ws.data as { path?: string } | undefined)?.path ?? "";
        const id = (ws as typeof ws & { connId: string }).connId;
        if (path.startsWith("/api/console/terminal/ws")) {
          if (id) terminalBridge.disconnect(id);
          return;
        }
        if (id) wsHandler.disconnect(id);
      },
    },
  });

  const stopObservability = currentObservabilityWatcher;
  const stopSpecialistsBump = currentSpecialistsBumpUnsubscribe;
  process.once("exit", () => {
    stopObservability?.stop();
    stopSpecialistsBump?.();
  });

  console.log(`[xtrm] Server running at http://${hostname}:${port}`);
  console.log(`[xtrm] - Gitboard: http://${hostname}:${port}/gitboard`);
  console.log(`[xtrm] - Beadboard: http://${hostname}:${port}/beadboard`);
  console.log(`[xtrm] - Console: http://${hostname}:${port}/console`);
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
