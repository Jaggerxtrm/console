import type { Database } from "bun:sqlite";
import { emit } from "../../core/logger.ts";
import {
  createSpecialistsRouter as createConsoleSpecialistsRouter,
  type SpecialistsDao,
  type SpecialistsRouterOptions,
} from "../../../../console/src/server/routes/specialists.ts";

export type { SpecialistsDao, SpecialistsRouterOptions } from "../../../../console/src/server/routes/specialists.ts";
export {
  MAX_IN_FLIGHT_REFRESHES,
  MAX_REPO_SLUG_FILTERS,
  MAX_REPO_SLUG_FILTER_BYTES,
  MAX_SPECIALIST_FEED_OUTPUT_BYTES,
  isSpecialistResultRequestAllowed,
  runSpecialistFeed,
} from "../../../../console/src/server/routes/specialists.ts";

export function createSpecialistsRouter(
  dao?: SpecialistsDao,
  xtrmDb?: Database | SpecialistsRouterOptions,
  options: SpecialistsRouterOptions = {},
) {
  if (isRouterOptions(xtrmDb)) {
    return createConsoleSpecialistsRouter(dao, { ...xtrmDb, emit: xtrmDb.emit ?? emit });
  }
  return createConsoleSpecialistsRouter(dao, xtrmDb, { ...options, emit: options.emit ?? emit });
}

function isRouterOptions(value: Database | SpecialistsRouterOptions | undefined): value is SpecialistsRouterOptions {
  return typeof value === "object" && value !== null && !("query" in value);
}
