import type { Database } from "bun:sqlite";
import { emit } from "../../core/logger.ts";
import { createExploreAgentopsRouter as createConsoleExploreAgentopsRouter, type ExploreAgentopsOptions } from "../../../../console/src/server/routes/explore-agentops.ts";

export type { ExploreAgentopsRange, ExploreAgentopsFilters, ExploreAgentopsOptions } from "../../../../console/src/server/routes/explore-agentops.ts";

export function createExploreAgentopsRouter(db: Database | null | undefined, options: ExploreAgentopsOptions = {}) {
  return createConsoleExploreAgentopsRouter(db, { ...options, emit: options.emit ?? emit });
}
