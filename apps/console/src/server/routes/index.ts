import type { Database } from "bun:sqlite";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import type { BeadsParitySummary } from "../../../../../packages/core/src/runtime/beads-parity.ts";
import { makeSourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import type { HostLogger } from "../log.ts";
import { createBeadsWriteRouter } from "./beads-write.ts";
import { createExploreAgentopsRouter } from "./explore-agentops.ts";
import { createExploreSqlRouter, type ExploreSqlProxyOptions } from "./explore-sql.ts";
import { createFeedRouter } from "./feed.ts";
import { createGraphRouter, createXtrmGraphRoute, type GraphRouteDao } from "./graph.ts";
import { createGithubRouter } from "./github.ts";
import { createInternalDoltHealthRouter } from "./internal-dolt-health.ts";
import { createInternalLogsRouter } from "./internal-logs.ts";
import { createInternalParityRouter, type InternalParityHarness } from "./internal-parity.ts";
import { createInternalSubstrateRouter } from "./internal-substrate.ts";
import { createInternalVerifyRouter } from "./internal-verify.ts";
import { createObservabilityRouter, type ObservabilityMetricsDao } from "./observability.ts";
import { createSourcesRouter, type SourceScanner } from "./sources.ts";
import { createSpecialistsConfigRouter } from "./specialists-config.ts";
import { createSpecialistsControlRouter } from "./specialists-control.ts";
import { createSpecialistsRouter } from "./specialists.ts";
import { createSubstrateRouter } from "./substrate.ts";

export interface ConsoleApiRouteOptions {
  readonly db: Database | null;
  readonly logger: HostLogger;
  readonly scanner?: SourceScanner | null;
  readonly graphDao?: GraphRouteDao;
  readonly triggerMaterialization?: (projectId?: string | null) => void;
  readonly observabilityParityHarness?: InternalParityHarness | null;
  readonly beadsParityHarness?: {
    getParityOkCount(): number;
    getLatestSummary(): BeadsParitySummary | null;
  } | null;
  readonly observabilityDao?: ObservabilityMetricsDao;
  readonly githubPublisherOrRegistry?: unknown;
  readonly datasetteDebugEnabled?: boolean;
  readonly exploreSqlOptions?: ExploreSqlProxyOptions;
}

export const CONSOLE_PHASE2_ROUTE_PREFIXES = [
  "/api/substrate",
  "/api/feed",
  "/api/console/graph",
  "/api/sources",
  "/api/internal",
] as const;

export const CONSOLE_API_ROUTE_PREFIXES = [
  ...CONSOLE_PHASE2_ROUTE_PREFIXES,
  "/api/github",
  "/api/specialists",
  "/api/specialists/config",
  "/api/console/specialists",
  "/api/console/observability",
  "/api/console/explore",
] as const;

export function createConsoleApiRouter(options: ConsoleApiRouteOptions): Hono {
  const app = new Hono();
  const graphDao = options.graphDao
    ?? (options.db ? createXtrmGraphRoute(options.db, options.triggerMaterialization) : unavailableGraphDao());

  app.use("*", cors());
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } catch (error) {
      options.logger.emit(makeLogEntry("api", "request.error", "error", "request failed", {
        path: c.req.path,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      if (c.req.path.startsWith("/api/github") || c.req.path.startsWith("/api/console")) {
        options.logger.emit(makeLogEntry("api", "request.timing", "info", undefined, {
          path: c.req.path,
          ms: durationMs,
          status: c.res.status,
        }));
      }
      if (durationMs > 500) {
        options.logger.emit(makeLogEntry("api", "request.slow", "warn", "slow request", { path: c.req.path, ms: durationMs }));
      }
      if (c.res.status >= 400) {
        options.logger.emit(makeLogEntry("api", "request.error", c.res.status >= 500 ? "error" : "warn", "request failed", {
          path: c.req.path,
          status: c.res.status,
        }));
      }
    }
  });

  app.route("/api/substrate", createSubstrateRouter(options.db, { emit: options.logger.emit }));
  app.route("/api/substrate", createBeadsWriteRouter(options.db, { emit: options.logger.emit }));
  app.route("/api/feed", createFeedRouter(options.db));
  if (options.db) app.route("/api/github", createGithubRouter(options.db, options.githubPublisherOrRegistry, options.logger));
  app.route("/api/specialists", createSpecialistsRouter(undefined, options.db ?? undefined, { emit: options.logger.emit }));
  app.route("/api/console/specialists", createSpecialistsControlRouter(options.db, { emit: options.logger.emit }));
  app.route("/api/specialists/config", createSpecialistsConfigRouter({ emit: options.logger.emit }));
  if (options.db || options.observabilityDao) {
    app.route("/api/console/observability", createObservabilityRouter(options.observabilityDao, options.db));
  }
  app.route("/api/console/explore", createExploreAgentopsRouter(options.db, { emit: options.logger.emit }));
  if (options.datasetteDebugEnabled) {
    const datasette = createExploreSqlRouter({
      ...options.exploreSqlOptions,
      emit: options.exploreSqlOptions?.emit ?? options.logger.emit,
    });
    const proxyDatasette = (c: Context) => datasette.fetch(c.req.raw);
    app.all("/explore/sql", proxyDatasette);
    app.all("/explore/sql/*", proxyDatasette);
  }
  app.route("/api/console/graph", createGraphRouter(graphDao));
  app.route("/api/sources", createSourcesRouter(options.db, options.scanner ?? null));
  app.route("/api/internal", createInternalDoltHealthRouter());
  app.route("/api/internal", createInternalLogsRouter(options.logger));
  app.route("/api/internal", createInternalSubstrateRouter(options.db));
  app.route("/api/internal", createInternalVerifyRouter({ emit: options.logger.emit }));
  app.route("/api/internal", createInternalParityRouter(() => options.observabilityParityHarness ?? null));
  app.get("/api/internal/parity/beads", (c) => {
    if (!isTrustedLocalhostRequest(c.req.url, c.req.header("host") ?? "", c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) return c.json({ error: "forbidden" }, 403);
    return c.json({
      parity_ok_count: options.beadsParityHarness?.getParityOkCount() ?? 0,
      latest_summary: options.beadsParityHarness?.getLatestSummary() ?? null,
    });
  });

  return app;
}

function unavailableGraphDao(): GraphRouteDao {
  return {
    requiresProtectedRefresh: true,
    getGraphSnapshotWarm: async (projectId) => ({
      graph: {
        project_id: projectId ?? "",
        repo_slug: projectId ?? "",
        generated_at: new Date(0).toISOString(),
        nodes: [],
        edges: [],
        specialists: [],
      },
      freshness: "degraded",
      sourceHealth: makeSourceHealth("graph", "degraded", { message: "xtrm.sqlite unavailable" }),
    }),
  };
}
