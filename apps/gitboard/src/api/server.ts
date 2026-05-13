import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import { createConsoleRouter } from "./routes/console.ts";
import { createGithubRouter } from "./routes/github.ts";
import { beadsRoutes } from "../../../beadboard/src/api/routes/beads.ts";
import { ChannelRegistry } from "./ws/channels.ts";
import { WsHandler } from "./ws/handler.ts";

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

const repoRoot = process.cwd().endsWith("/apps/gitboard") ? join(process.cwd(), "../..") : process.cwd();
const gitboardDist = join(repoRoot, "apps/gitboard/dist/dashboard");
const beadboardDist = join(repoRoot, "apps/beadboard/dist/dashboard");

export function createApp(db: Database): {
  app: Hono;
  registry: ChannelRegistry;
  wsHandler: WsHandler;
} {
  const app = new Hono();
  const registry = new ChannelRegistry();
  const wsHandler = new WsHandler(registry);

  app.use("*", cors());

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // API routes
  app.route("/api/console", createConsoleRouter(db));
  app.route("/api/github", createGithubRouter(db, registry));
  app.route("/api/beads", beadsRoutes);

  // Serve built dashboards in production
  if (process.env.NODE_ENV === "production") {
    // Gitboard - serve assets and SPA
    app.get("/gitboard/assets/*", async (c) => {
      const path = c.req.path.replace("/gitboard", "/gitboard");
      const file = Bun.file(join(gitboardDist, path));
      if (await file.exists()) return new Response(file, { headers: staticHeaders(path) });
      return c.notFound();
    });

    const serveGitboardSpa = async () => {
      const file = Bun.file(join(gitboardDist, "gitboard/index.html"));
      return new Response(file, { headers: htmlHeaders() });
    };

    app.get("/gitboard", serveGitboardSpa);
    app.get("/gitboard/*", serveGitboardSpa);
    app.get("/console", serveGitboardSpa);
    app.get("/console/*", serveGitboardSpa);

    // Beadboard - serve assets and SPA
    app.get("/beadboard/assets/*", async (c) => {
      const path = c.req.path.replace("/beadboard", "/beadboard");
      const file = Bun.file(join(beadboardDist, path));
      if (await file.exists()) return new Response(file, { headers: staticHeaders(path) });
      return c.notFound();
    });

    app.get("/beadboard", async (c) => {
      const file = Bun.file(join(beadboardDist, "beadboard/index.html"));
      return new Response(file, { headers: htmlHeaders() });
    });

    app.get("/beadboard/*", async (c) => {
      const file = Bun.file(join(beadboardDist, "beadboard/index.html"));
      return new Response(file, { headers: htmlHeaders() });
    });

    // Root redirects to the unified xtrm console.
    app.get("/", (c) => c.redirect("/console"));
  }

  return { app, registry, wsHandler };
}

export function startServer(db: Database, options: ServerOptions = {}): void {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost");

  const { app, wsHandler } = createApp(db);

  Bun.serve({
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

  console.log(`[xtrm] Server running at http://${hostname}:${port}`);
  console.log(`[xtrm] - Console: http://${hostname}:${port}/console`);
  console.log(`[xtrm] - Gitboard: http://${hostname}:${port}/gitboard`);
  console.log(`[xtrm] - Beadboard: http://${hostname}:${port}/beadboard`);
}

function staticHeaders(path: string): HeadersInit {
  return {
    "Content-Type": contentType(path),
    "Cache-Control": "no-store, max-age=0",
  };
}

function htmlHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  };
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
