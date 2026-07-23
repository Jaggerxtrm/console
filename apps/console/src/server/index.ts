import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { acquireRuntimeWriterLease } from "../../../../packages/core/src/runtime/writer-lease.ts";
import { createDatabaseBootstrap } from "./database.ts";
import { resolveDataDir } from "./data-dir.ts";
import { CONSOLE_HOST_OWNER, createConsoleHost } from "./host.ts";
import { createHostLogger } from "./log.ts";
import { createGithubRuntime } from "./github/runtime.ts";
import { createConsoleRuntime } from "./runtime-lifecycle.ts";
import { CONSOLE_API_ROUTE_PREFIXES, createConsoleApiRouter } from "./routes/index.ts";
import { createConsoleRealtime } from "./ws/realtime.ts";

const logger = createHostLogger();
const dataDir = resolveDataDir();
const database = createDatabaseBootstrap(dataDir, createXtrmDatabase);
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST?.trim() || "127.0.0.1";
database.ensureDataDir();
const writerLease = acquireRuntimeWriterLease(database.storeDbPath, { owner: CONSOLE_HOST_OWNER });
const databaseHandle = database.open();
const realtime = createConsoleRealtime({ logger });
const githubRuntime = createGithubRuntime({ db: databaseHandle.db, logger, publisher: realtime.registry });
const consoleRuntime = createConsoleRuntime({ db: databaseHandle.db, logger, publisher: realtime.registry });
const apiRouter = createConsoleApiRouter({
  db: databaseHandle.db,
  logger,
  scanner: consoleRuntime.scanner,
  triggerMaterialization: consoleRuntime.triggerMaterialization,
  observabilityParityHarness: consoleRuntime.observabilityParityHarness,
  beadsParityHarness: consoleRuntime.beadsParityHarness,
  datasetteDebugEnabled: process.env.EXPLORE_DATASETTE_DEBUG === "1",
});

const host = createConsoleHost({
  port,
  hostname,
  dataDir,
  database,
  logger,
  runtimeCapabilities: ["materializer", "source-health", "websocket"],
  hooks: {
    mountRoutes: (app) => {
      app.route("/", apiRouter);
      return CONSOLE_API_ROUTE_PREFIXES;
    },
    handleWebSocketUpgrade: realtime.handleUpgrade,
    websocket: realtime.websocket,
    startBackground: async () => {
      await consoleRuntime.start();
      await githubRuntime.start();
    },
    stopBackground: async () => {
      const errors: unknown[] = [];
      try {
        await githubRuntime.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await consoleRuntime.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        realtime.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, "background runtime shutdown failed");
    },
  },
});

logger.info("host.starting", {
  owner: CONSOLE_HOST_OWNER,
  dataDirSource: dataDir.source,
  consoleDistSource: process.env.CONSOLE_DIST_DIR?.trim() ? "configured" : "default",
  requestedPort: port,
  hostname,
  capabilities: host.descriptor.capabilities,
  writerLease: "acquired",
});

const running = await host.start();

logger.info("host.listening", {
  owner: CONSOLE_HOST_OWNER,
  url: running.url,
  port: running.port,
  hostname: running.hostname,
  mountedRoutes: host.descriptor.mountedRoutes,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("host.shutting_down", { signal });
  const errors: unknown[] = [];
  try {
    await running.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    databaseHandle.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    writerLease.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) logger.info("host.shutdown", { signal });
  else logger.error("host.shutdown_failed", {
    signal,
    error_count: errors.length,
    error_types: errors.map((error) => error instanceof Error ? error.name : "Error"),
  });
  try { await logger.flush(); } catch { errors.push(new Error("logger flush failed")); }
  process.exit(errors.length === 0 ? 0 : 1);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
