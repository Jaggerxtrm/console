import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { makeSourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import type { HostLogger } from "../log.ts";
import { createBeadsWriteRouter } from "./beads-write.ts";
import { createFeedRouter } from "./feed.ts";
import { createGraphRouter, createXtrmGraphRoute, type GraphRouteDao } from "./graph.ts";
import { createInternalDoltHealthRouter } from "./internal-dolt-health.ts";
import { createInternalLogsRouter } from "./internal-logs.ts";
import { createInternalParityRouter, type InternalParityHarness } from "./internal-parity.ts";
import { createInternalSubstrateRouter } from "./internal-substrate.ts";
import { createInternalVerifyRouter } from "./internal-verify.ts";
import { createSourcesRouter, type SourceScanner } from "./sources.ts";
import { createSubstrateRouter } from "./substrate.ts";

export interface ConsoleApiRouteOptions {
  readonly db: Database | null;
  readonly logger: HostLogger;
  readonly scanner?: SourceScanner | null;
  readonly graphDao?: GraphRouteDao;
  readonly triggerMaterialization?: (projectId?: string | null) => void;
  readonly observabilityParityHarness?: InternalParityHarness | null;
  readonly beadsParityHarness?: InternalParityHarness | null;
}

export const CONSOLE_PHASE2_ROUTE_PREFIXES = [
  "/api/substrate",
  "/api/feed",
  "/api/console/graph",
  "/api/sources",
  "/api/internal",
] as const;

export function createConsoleApiRouter(options: ConsoleApiRouteOptions): Hono {
  const app = new Hono();
  const graphDao = options.graphDao
    ?? (options.db ? createXtrmGraphRoute(options.db, options.triggerMaterialization) : unavailableGraphDao());

  app.route("/api/substrate", createSubstrateRouter(options.db, { emit: options.logger.emit }));
  app.route("/api/substrate", createBeadsWriteRouter(options.db, { emit: options.logger.emit }));
  app.route("/api/feed", createFeedRouter(options.db));
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
