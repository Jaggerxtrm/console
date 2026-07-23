import type { Database } from "bun:sqlite";
import { emit } from "../../core/logger.ts";
import {
  createSubstrateRouter as createConsoleSubstrateRouter,
  type SubstrateRouterOptions,
} from "../../../../console/src/server/routes/substrate.ts";

export type { SubstrateRouterOptions };

export function createSubstrateRouter(xtrmDb?: Database | null, options: SubstrateRouterOptions = {}) {
  return createConsoleSubstrateRouter(xtrmDb, { ...options, emit: options.emit ?? emit });
}
