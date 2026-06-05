import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "./routes/github.ts";
import { createInternalDoltHealthRouter } from "./routes/internal-dolt-health.ts";
import { createInternalLogsRouter } from "./routes/internal-logs.ts";
import { createInternalSubstrateRouter } from "./routes/internal-substrate.ts";
import { createInternalVerifyRouter } from "./routes/internal-verify.ts";
import { createInternalParityRouter } from "./routes/internal-parity.ts";
import { setRealtimePublisher, emit, makeLogEntry } from "../core/logger.ts";
import { createSubstrateRouter } from "./routes/substrate.ts";
import { createSpecialistsRouter } from "./routes/specialists.ts";
import { createObservabilityRouter } from "./routes/observability.ts";
import { createGraphRouter } from "./routes/graph.ts";
import { createFeedRouter } from "./routes/feed.ts";
import { createGraphDao } from "../core/graph-dao.ts";
import { createShellRouter } from "./routes/shell.ts";
import { createSourcesRouter } from "./routes/sources.ts";
import { createTerminalRouter } from "./routes/terminal.ts";
import { ChannelRegistry, type ChannelName } from "./ws/channels.ts";
import { WsHandler } from "./ws/handler.ts";
import { Materializer } from "../core/materializer/index.ts";
import { createObservabilityAdapter } from "../core/materializer/observability-adapter.ts";
import { createObservabilityParityHarness } from "../server/observability/parity.ts";
import { onBump } from "../server/observability/epoch.ts";
import { createBeadsParityHarness } from "./routes/beads-parity.ts";
import { TriggerWatcher } from "../server/beads/trigger-watcher.ts";
import { createObservabilityWatcher } from "../server/observability/watcher.ts";
import { listRepos } from "../server/observability/registry.ts";
import { UnifiedScanner } from "../core/unified-scanner.ts";
import { getShellProviderStatus, isAllowedShellWebSocketOrigin, isShellWebSocketPath, isVerifiedShellAdminRequest, shouldRejectShellWebSocket } from "../core/shell-provider-policy.ts";
import { createTerminalProviderRegistry } from "./terminal/provider-registry.ts";
import { TerminalBridge } from "./terminal/bridge.ts";

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

let currentRegistry: ChannelRegistry | null = null;
let currentWatcher: TriggerWatcher | null = null;
let currentObservabilityWatcher: ReturnType<typeof createObservabilityWatcher> | null = null;
let currentMaterializer: Materializer | null = null;
let currentUnifiedScanner: UnifiedScanner | null = null;
let currentBeadsParityHarness: ReturnType<typeof createBeadsParityHarness> | null = null;
let currentObservabilityParityHarness: ReturnType<typeof createObservabilityParityHarness> | null = null;
let currentEpochBumpUnsubscribe: (() => void) | null = null;

export function getCurrentRegistry(): ChannelRegistry | null {
  return currentRegistry;
}

export function getCurrentMaterializer(): Materializer | null {
  return currentMaterializer;
}

const repoRoot = process.cwd().endsWith("/apps/gitboard") ? join(process.cwd(), "../..") : process.cwd();
const gitboardDist = join(repoRoot, "apps/gitboard/dist/dashboard");
// beadboardDist removed (forge-5w9.9) — frontend deprecated; /beadboard redirects to /gitboard.

type AppVariables = {
  parityHarness: ReturnType<typeof createObservabilityParityHarness> | null;
};

export function createApp(db: Database, xtrmDb?: Database): {
  app: Hono<{ Variables: AppVariables }>;
  registry: ChannelRegistry;
  wsHandler: WsHandler;
  materializer: Materializer | null;
} {
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = new ChannelRegistry();
  currentRegistry = registry;
  const storeDb = xtrmDb ?? db;
  const materializer = xtrmDb ? new Materializer(storeDb, registry) : null;
  currentMaterializer = materializer;
  const obsRepos = listRepos();
  currentUnifiedScanner?.stop();
  currentUnifiedScanner = xtrmDb ? new UnifiedScanner(storeDb, { parityEnabled: process.env.GITBOARD_ENABLE_PARITY === "1" }) : null;
  currentUnifiedScanner?.start();
  if (materializer && xtrmDb) {
    for (const repo of obsRepos) {
      const sourceKey = `obs:${repo.repoSlug}`;
      xtrmDb.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, 'observability', ?, 'discovered', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET path=excluded.path, status=excluded.status, last_seen_at=excluded.last_seen_at").run(sourceKey, repo.dbPath);
      materializer.register(sourceKey, createObservabilityAdapter(repo.dbPath, repo.repoSlug));
    }
    currentEpochBumpUnsubscribe?.();
    currentEpochBumpUnsubscribe = onBump((repoSlug) => {
      const sourceKey = `obs:${repoSlug}`;
      for (const channel of ["specialists:activity", `specialists:repo:${repoSlug}`] as ChannelName[]) {
        registry.publish(channel, "specialists:sync_hint", { source_key: sourceKey, kind: "epoch_bump" }, String(Date.now()));
      }
    });
    queueMicrotask(() => {
      for (const repo of obsRepos) materializer.trigger(`obs:${repo.repoSlug}`);
    });
  }
  const wsHandler = new WsHandler(registry);
  setRealtimePublisher(registry);
  if (materializer && xtrmDb) currentWatcher = new TriggerWatcher(materializer, xtrmDb, registry);
  currentWatcher?.start();
  currentObservabilityWatcher?.stop();
  currentObservabilityWatcher = createObservabilityWatcher(obsRepos);
  currentObservabilityWatcher.start();
  // Parity harnesses are shadow-mode diagnostics for the P1/P2 validation
  // window only. Default OFF in prod; set GITBOARD_ENABLE_PARITY=1 to enable.
  // Both run on 30s timers and rebuild full-project diffs each cycle (Beads
  // parity does a filesystem scan + reads up to 1000 issues per project),
  // which OOM'd prod on first deploy (forge-eorh.47).
  const parityEnabled = process.env.GITBOARD_ENABLE_PARITY === "1";
  currentObservabilityParityHarness?.stop();
  currentObservabilityParityHarness = createObservabilityParityHarness(xtrmDb ?? null, { enabled: parityEnabled });
  if (parityEnabled) currentObservabilityParityHarness.start();
  currentBeadsParityHarness?.stop();
  currentBeadsParityHarness = createBeadsParityHarness(xtrmDb ?? null, { enabled: parityEnabled && process.env.NODE_ENV !== "test" });
  if (parityEnabled) currentBeadsParityHarness.start();

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
      if (c.req.path.startsWith("/api/github") || c.req.path.startsWith("/api/console")) {
        emit(makeLogEntry("api", "request.timing", "info", undefined, { path: c.req.path, ms, status: c.res.status }));
      }
      if (ms > 500) emit(makeLogEntry("api", "request.slow", "warn", "slow request", { path: c.req.path, ms }));
      if (c.res.status >= 400) emit(makeLogEntry("api", "request.error", c.res.status >= 500 ? "error" : "warn", "request failed", { path: c.req.path, status: c.res.status }));
    }
  });

  app.use("*", async (c, next) => {
    c.set("parityHarness", currentObservabilityParityHarness);
    await next();
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // API routes
  app.route("/api/github", createGithubRouter(storeDb, registry));
  app.route("/api/substrate", createSubstrateRouter(xtrmDb ?? null));
  app.route("/api/specialists", createSpecialistsRouter(undefined, xtrmDb));
  app.route("/api/console/observability", createObservabilityRouter(undefined, xtrmDb));
  app.route("/api/console/graph", createGraphRouter(xtrmDb ? createGraphDao({
    xtrmDb,
    triggerMaterialization: (projectId) => {
      if (!projectId) return;
      materializer?.trigger(`beads:${projectId}`);
    },
  }) : undefined));
  app.route("/api/feed", createFeedRouter(xtrmDb ?? null));
  app.route("/api/sources", createSourcesRouter(xtrmDb ?? null, currentUnifiedScanner));
  app.route("/api/console/shell", createShellRouter());
  app.route("/api/console/terminal", createTerminalRouter());
  app.route("/api/internal", createInternalDoltHealthRouter());
  app.route("/api/internal", createInternalLogsRouter());
  app.route("/api/internal", createInternalSubstrateRouter(xtrmDb ?? null));
  app.route("/api/internal", createInternalVerifyRouter());
  app.route("/api/internal", createInternalParityRouter());
  app.get("/api/internal/parity/beads", (c) => {
    if (!String(c.req.header("host") ?? "").startsWith("localhost") && !String(c.req.header("host") ?? "").startsWith("127.0.0.1") && !String(c.req.header("host") ?? "").startsWith("[::1]")) return c.json({ error: "forbidden" }, 403);
    return c.json({ parity_ok_count: currentBeadsParityHarness?.getParityOkCount() ?? 0, latest_summary: currentBeadsParityHarness?.getLatestSummary() ?? null });
  });

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

    // Root redirects to gitboard
    app.get("/", (c) => c.redirect("/gitboard"));
  }

  return { app, registry, wsHandler, materializer };
}

export function startServer(xtrmDb: Database, options: ServerOptions = {}): void {
  const port = options.port ?? 3030;
  const hostname = options.hostname ?? process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

  const { app, wsHandler } = createApp(xtrmDb, xtrmDb);
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
  process.once("exit", () => {
    stopObservability?.stop();
    currentEpochBumpUnsubscribe?.();
    currentObservabilityParityHarness?.stop();
    currentBeadsParityHarness?.stop();
    currentUnifiedScanner?.stop();
  });

  console.log(`[xtrm] Server running at http://${hostname}:${port}`);
  console.log(`[xtrm] - Gitboard: http://${hostname}:${port}/gitboard`);
  console.log(`[xtrm] - Console: http://${hostname}:${port}/console`);
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
