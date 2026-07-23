import type { Database } from "bun:sqlite";
import { emit } from "../../core/logger.ts";
import {
  createBeadsWriteRouter as createConsoleBeadsWriteRouter,
  resolveRepoPathFromBeadsPath,
  type BeadsWriteRouterOptions,
} from "../../../../console/src/server/routes/beads-write.ts";

export { resolveRepoPathFromBeadsPath };
export type { BeadsWriteRouterOptions };

export function createBeadsWriteRouter(xtrmDb?: Database | null, options: BeadsWriteRouterOptions = {}) {
  return createConsoleBeadsWriteRouter(xtrmDb, { ...options, emit: options.emit ?? emit });
}
