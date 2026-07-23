import { emit } from "../../core/logger.ts";
import { createExploreSqlRouter as createConsoleExploreSqlRouter, type ExploreSqlProxyOptions } from "../../../../console/src/server/routes/explore-sql.ts";

export type { ExploreSqlProxyOptions } from "../../../../console/src/server/routes/explore-sql.ts";
export { toUpstreamUrl, isLocalDebugRequest } from "../../../../console/src/server/routes/explore-sql.ts";

export function createExploreSqlRouter(options: ExploreSqlProxyOptions = {}) {
  return createConsoleExploreSqlRouter({ ...options, emit: options.emit ?? emit });
}
