import type { Database } from "bun:sqlite";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import type {
  GithubActivityPublisher,
  GithubAdapterLogEntry,
  GithubPollerOptions,
} from "../../../../../packages/core/src/github/index.ts";
import type { HostLogger } from "../log.ts";
import { discoverAndInsert } from "./discover.ts";
import {
  createGithubPoller,
  getAuthenticatedUsername,
  getGithubToken,
} from "./poller.ts";

export interface GithubRuntimePoller {
  start(username: string): void;
  stop(): void;
  backfill(username: string): Promise<void>;
}

export interface GithubRuntimeOptions {
  readonly db: Database;
  readonly logger: HostLogger;
  readonly publisher?: GithubActivityPublisher;
  readonly env?: NodeJS.ProcessEnv;
  readonly getToken?: () => string;
  readonly getUsername?: (token: string) => Promise<string>;
  readonly discover?: (db: Database) => Promise<unknown>;
  readonly createPoller?: (db: Database, token: string, options: GithubPollerOptions) => GithubRuntimePoller;
  readonly pollerOptions?: GithubPollerOptions;
}

export type GithubRuntimeStatus =
  | { state: "idle" | "running" | "stopped" }
  | { state: "disabled" | "degraded"; reason: string };

export function createGithubRuntime(options: GithubRuntimeOptions) {
  const env = options.env ?? process.env;
  const tokenProvider = options.getToken ?? getGithubToken;
  const usernameProvider = options.getUsername ?? getAuthenticatedUsername;
  const discover = options.discover ?? discoverAndInsert;
  const pollerFactory = options.createPoller ?? createGithubPoller;
  let poller: GithubRuntimePoller | null = null;
  let started = false;
  let stopped = false;
  let currentStatus: GithubRuntimeStatus = { state: "idle" };

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;

    if (env.SKIP_GITHUB_POLLER === "1") {
      currentStatus = { state: "disabled", reason: "configured_off" };
      options.logger.info("github.poller_disabled", { reason: "configured_off" });
      return;
    }

    try {
      const token = tokenProvider();
      const username = await usernameProvider(token);
      if (stopped) return;
      await discover(options.db);
      if (stopped) return;
      // Ingestion scope is decided here, where the identity already is: the
      // authenticated account plus its organizations. A failed organization read
      // narrows to the account alone - it never widens to every repository the
      // event feed happens to mention.
      const owners = [username, ...(await readOrgLogins(token, options.logger))];
      poller = pollerFactory(options.db, token, {
        owners,
        ...options.pollerOptions,
        registry: options.pollerOptions?.registry ?? options.publisher,
        logger: options.pollerOptions?.logger ?? { emit: emitGithubLog },
      });
      if (env.GITBOARD_STARTUP_BACKFILL === "1") {
        void poller.backfill(username).catch((error) => {
          options.logger.warn("github.startup_backfill_failed", { error: errorMessage(error) });
        });
      }
      poller.start(username);
      currentStatus = { state: "running" };
      options.logger.info("github.poller_started", { username, owners, startupBackfill: env.GITBOARD_STARTUP_BACKFILL === "1" });
    } catch (error) {
      if (stopped) return;
      const reason = errorMessage(error);
      poller = null;
      currentStatus = { state: "degraded", reason };
      options.logger.warn("github.poller_degraded", { reason });
    }
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (!poller) return;
    poller.stop();
    poller = null;
    currentStatus = { state: "stopped" };
    options.logger.info("github.poller_stopped");
  }

  function emitGithubLog(entry: GithubAdapterLogEntry): void {
    const component = entry.component === "github" ? "poller" : entry.component;
    options.logger.emit(makeLogEntry(component, entry.event, entry.level, entry.msg, entry.data));
  }

  return { start, stop, status: () => currentStatus };
}

async function readOrgLogins(token: string, logger: { warn: (event: string, data?: Record<string, unknown>) => void }): Promise<string[]> {
  try {
    const response = await fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "xtrm-console" },
    });
    if (!response.ok) {
      logger.warn("github.orgs_unavailable", { status: response.status });
      return [];
    }
    return ((await response.json()) as Array<{ login?: string }>).map((o) => o.login).filter((l): l is string => !!l);
  } catch (error) {
    logger.warn("github.orgs_unavailable", { error: errorMessage(error) });
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
