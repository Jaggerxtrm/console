import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDatabase } from "./core/store.ts";
import { GithubPoller, getGithubToken, getAuthenticatedUsername } from "./core/github-poller.ts";
import { discoverAndInsert } from "./core/github-discover.ts";
import { startServer } from "./api/server.ts";

const DB_PATH = process.env.AGENT_FORGE_DB ?? `${process.env.HOME}/.agent-forge/state.db`;
mkdirSync(dirname(DB_PATH), { recursive: true });
const PORT = Number(process.env.PORT ?? 3000);

const db = createDatabase(DB_PATH);
console.log(`[gitboard] Database initialized at ${DB_PATH}`);

startServer(db, { port: PORT });

try {
  if (process.env.SKIP_GITHUB_POLLER === "1") {
    console.log("[gitboard] GitHub poller disabled: SKIP_GITHUB_POLLER=1");
    process.on("SIGINT", () => {
      db.close();
      process.exit(0);
    });
  } else {
  const token = getGithubToken();
  const username = await getAuthenticatedUsername(token);

  // Auto-discover repos on first run so the DB is populated
  await discoverAndInsert(db);

  const poller = new GithubPoller(db, token);

  console.log(`[gitboard] Backfilling events for user ${username}...`);
  await poller.backfill(username);
  poller.start(username);
  console.log(`[gitboard] GitHub poller running for ${username}`);

  process.on("SIGINT", () => {
    console.log("\n[gitboard] Shutting down...");
    poller.stop();
    db.close();
    process.exit(0);
  });
  }
} catch (err) {
  console.warn("[gitboard] GitHub poller disabled:", (err as Error).message);
  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });
}
