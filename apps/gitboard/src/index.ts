import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { foldGitboardSQLite } from "./core/migrations/fold-gitboard-sqlite.ts";
import { createXtrmDatabase } from "./core/xtrm-store.ts";
import { GithubPoller, getGithubToken, getAuthenticatedUsername } from "./core/github-poller.ts";
import { discoverAndInsert } from "./core/github-discover.ts";
import { startServer, getCurrentRegistry } from "./api/server.ts";
import { emit, emitLogPath, makeLogEntry, setLogLevel } from "./core/logger.ts";
import { acquireRuntimeWriterLease } from "../../../packages/core/src/runtime/writer-lease.ts";

const DATA_DIR = process.env.XTRM_DATA_DIR ?? process.env.GITBOARD_DATA_DIR ?? `${process.env.HOME}/.agent-forge`;
const GITBOARD_DB_PATH = join(DATA_DIR, "gitboard.sqlite");
const XTRM_DB_PATH = join(DATA_DIR, "xtrm.sqlite");
mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT ?? 3030);
setLogLevel((process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info");
emitLogPath();

const writerLease = acquireRuntimeWriterLease(XTRM_DB_PATH, { owner: "apps/gitboard" });
const xtrmDb = createXtrmDatabase(XTRM_DB_PATH);
emit(makeLogEntry("store", "db.path", "info", undefined, { path: XTRM_DB_PATH }));
console.log(`[xtrm] Database initialized at ${XTRM_DB_PATH}`);

foldGitboardSQLite(GITBOARD_DB_PATH, xtrmDb);
startServer(xtrmDb, { port: PORT });

let stopBackground = (): void => {};
try {
  if (process.env.SKIP_GITHUB_POLLER === "1") {
    console.log("[gitboard] GitHub poller disabled: SKIP_GITHUB_POLLER=1");
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
    stopBackground = () => poller.stop();
  }
} catch (err) {
  console.warn("[gitboard] GitHub poller disabled:", (err as Error).message);
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[gitboard] Shutting down (${signal})...`);
  const errors: unknown[] = [];
  try { stopBackground(); } catch (error) { errors.push(error); }
  try { xtrmDb.close(); } catch (error) { errors.push(error); }
  try { writerLease.release(); } catch (error) { errors.push(error); }
  if (errors.length > 0) console.error("[gitboard] shutdown failed", { error_count: errors.length });
  process.exit(errors.length === 0 ? 0 : 1);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
