import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { createDatabaseBootstrap } from "./database.ts";
import { redactHomePath, resolveDataDir } from "./data-dir.ts";
import { CONSOLE_HOST_OWNER, createConsoleHost } from "./host.ts";
import { createHostLogger } from "./log.ts";
import { CONSOLE_PHASE2_ROUTE_PREFIXES, createConsoleApiRouter } from "./routes/index.ts";

const logger = createHostLogger();
const dataDir = resolveDataDir();
const database = createDatabaseBootstrap(dataDir, createXtrmDatabase);
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST?.trim() || "127.0.0.1";
database.ensureDataDir();
const databaseHandle = database.open();
const apiRouter = createConsoleApiRouter({ db: databaseHandle.db, logger });

const host = createConsoleHost({
  port,
  hostname,
  dataDir,
  database,
  logger,
  hooks: {
    mountRoutes: (app) => {
      app.route("/", apiRouter);
      return CONSOLE_PHASE2_ROUTE_PREFIXES;
    },
  },
});

logger.info("host.starting", {
  owner: CONSOLE_HOST_OWNER,
  dataDirSource: dataDir.source,
  dataDir: redactHomePath(dataDir.dataDir),
  consoleDistDir: redactHomePath(host.consoleDistDir),
  requestedPort: port,
  hostname,
  capabilities: host.descriptor.capabilities,
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
  try {
    await running.stop();
    logger.info("host.shutdown", { signal });
    await logger.flush();
    databaseHandle.close();
    process.exit(0);
  } catch (error) {
    logger.error("host.shutdown_failed", {
      signal,
      error: error instanceof Error ? error.message : String(error),
    });
    databaseHandle.close();
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
