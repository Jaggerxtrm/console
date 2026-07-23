import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { createGithubRouter as createConsoleGithubRouter } from "../../../../console/src/server/routes/github.ts";
import { emit } from "../../core/logger.ts";
import type { ChannelRegistry } from "../ws/channels.ts";

export function createGithubRouter(db: Database, registry: ChannelRegistry): Hono {
  return createConsoleGithubRouter(db, registry, { emit });
}
