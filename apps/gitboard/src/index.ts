import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { foldGitboardSQLite } from "./core/migrations/fold-gitboard-sqlite.ts";
import { createXtrmDatabase } from "./core/xtrm-store.ts";
import { GithubPoller, getGithubToken, getAuthenticatedUsername } from "./core/github-poller.ts";
import { discoverAndInsert } from "./core/github-discover.ts";
import { startServer, getCurrentRegistry } from "./api/server.ts";
import { emit, emitLogPath, makeLogEntry, setLogLevel } from "./core/logger.ts";

const DATA_DIR = process.env.GITBOARD_DATA_DIR ?? `${process.env.HOME}/.agent-forge`;
const GITBOARD_DB_PATH = join(DATA_DIR, "gitboard.sqlite");
const XTRM_DB_PATH = join(DATA_DIR, "xtrm.sqlite");
mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT ?? 3030);
setLogLevel((process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info");
emitLogPath();

const xtrmDb = createXtrmDatabase(XTRM_DB_PATH);
emit(makeLogEntry("store", "db.path", "info", undefined, { path: XTRM_DB_PATH }));
console.log(`[xtrm] Database initialized at ${XTRM_DB_PATH}`);

foldGitboardSQLite(GITBOARD_DB_PATH, xtrmDb);
startServer(xtrmDb, { port: PORT });

try {
  if (process.env.SKIP_GITHUB_POLLER === "1") {
    console.log("[gitboard] GitHub poller disabled: SKIP_GITHUB_POLLER=1");
    process.on("SIGINT", () => {
      xtrmDb.close();
      process.exit(0);
    });
  } else {
    const token = getGithubToken();
    const username = await getAuthenticatedUsername(token);

    // Auto-discover repos on first run so the DB is populated
    await discoverAndInsert(xtrmDb);

    const poller = new GithubPoller(xtrmDb, token, { registry: getCurrentRegistry() ?? undefined });

    if (process.env.GITBOARD_STARTUP_BACKFILL === "1") {
      console.log(`[gitboard] Backfilling events for user ${username}...`);
      void poller.backfill(username).catch((error) => {
        console.warn("[gitboard] GitHub startup backfill failed:", (error as Error).message);
      });
    } else {
      console.log("[gitboard] GitHub startup backfill skipped: set GITBOARD_STARTUP_BACKFILL=1 to enable");
    }
    poller.start(username);
    console.log(`[gitboard] GitHub poller running for ${username}`);

    process.on("SIGINT", () => {
      console.log("\n[gitboard] Shutting down...");
      poller.stop();
      xtrmDb.close();
      process.exit(0);
    });
  }
} catch (err) {
  console.warn("[gitboard] GitHub poller disabled:", (err as Error).message);
  process.on("SIGINT", () => {
    xtrmDb.close();
    process.exit(0);
  });
}
