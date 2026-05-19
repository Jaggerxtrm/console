import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "./routes/github.ts";
import { createInternalDoltHealthRouter } from "./routes/internal-dolt-health.ts";
import { createInternalLogsRouter } from "./routes/internal-logs.ts";
import { setRealtimePublisher, emit, makeLogEntry } from "../core/logger.ts";
import { beadsRoutes } from "../../../beadboard/src/api/routes/beads.ts";
import { createSpecialistsRouter } from "./routes/specialists.ts";
import { ChannelRegistry } from "./ws/channels.ts";
import { WsHandler } from "./ws/handler.ts";
import { BeadsChangeWatcher } from "../../../beadboard/src/core/beads-change-watcher.ts";
import { createObservabilityWatcher } from "../server/observability/watcher.ts";
import { listRepos } from "../server/observability/registry.ts";

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

let currentRegistry: ChannelRegistry | null = null;
let currentWatcher: BeadsChangeWatcher | null = null;
let currentObservabilityWatcher: ReturnType<typeof createObservabilityWatcher> | null = null;

export function getCurrentRegistry(): ChannelRegistry | null {
  return currentRegistry;
}

const repoRoot = process.cwd().endsWith("/apps/gitboard") ? join(process.cwd(), "../..") : process.cwd();
const gitboardDist = join(repoRoot, "apps/gitboard/dist/dashboard");
// beadboardDist removed (forge-5w9.9) — frontend deprecated; /beadboard redirects to /gitboard.

export function createApp(db: Database): {
  app: Hono;
  registry: ChannelRegistry;
  wsHandler: WsHandler;
} {
  const app = new Hono();
  const registry = new ChannelRegistry();
  currentRegistry = registry;
  const wsHandler = new WsHandler(registry);
  setRealtimePublisher(registry);
  currentWatcher = new BeadsChangeWatcher({ registry });
  currentWatcher.start();
  currentObservabilityWatcher?.stop();
  currentObservabilityWatcher = createObservabilityWatcher(listRepos());
  currentObservabilityWatcher.start();

  app.use("*", cors());
  app.use("*", async (c, next) => {
    const start = Date.now();
    try {
      await next();
    } catch (error) {
      emit(makeLogEntry("api", "request.error", "error", "request failed", { path: c.req.path, error: (error as Error).message }));
      throw error;
    } finally {
      const ms = Date.now() - start;
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
  app.route("/api/internal", createInternalDoltHealthRouter());
  app.route("/api/internal", createInternalLogsRouter());

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

  return { app, registry, wsHandler };
}

export function startServer(db: Database, options: ServerOptions = {}): void {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");

  const { app, wsHandler } = createApp(db);

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        const upgraded = server.upgrade(req);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const id = wsHandler.connect({
          send: (data) => ws.send(data),
          close: () => ws.close(),
        });
        (ws as typeof ws & { connId: string }).connId = id;
        ws.send(JSON.stringify({ type: "connected", id }));
      },
      message(ws, msg) {
        const id = (ws as typeof ws & { connId: string }).connId;
        if (id) wsHandler.handleMessage(id, msg.toString());
      },
      close(ws) {
        const id = (ws as typeof ws & { connId: string }).connId;
        if (id) wsHandler.disconnect(id);
      },
    },
  });

  const stopObservability = currentObservabilityWatcher;
  process.once("exit", () => stopObservability?.stop());

  console.log(`[xtrm] Server running at http://${hostname}:${port}`);
  console.log(`[xtrm] - Gitboard: http://${hostname}:${port}/gitboard`);
  console.log(`[xtrm] - Beadboard: http://${hostname}:${port}/beadboard`);
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
