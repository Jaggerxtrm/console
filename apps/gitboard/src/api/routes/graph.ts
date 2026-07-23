import { createGraphDao } from "../../core/graph-dao.ts";
import {
  createGraphRouter as createConsoleGraphRouter,
  createXtrmGraphRoute,
  type GraphRouteDao,
} from "../../../../console/src/server/routes/graph.ts";

let defaultDao: ReturnType<typeof createGraphDao> | null = null;

export { createXtrmGraphRoute };
export type { GraphRouteDao };

export function createGraphRouter(dao: GraphRouteDao = getDefaultDao()) {
  return createConsoleGraphRouter(dao);
}

function getDefaultDao(): ReturnType<typeof createGraphDao> {
  if (!defaultDao) defaultDao = createGraphDao();
  return defaultDao;
}
