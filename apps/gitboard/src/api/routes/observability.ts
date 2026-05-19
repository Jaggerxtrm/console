import { Hono } from "hono";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createMetricsDao, type TimeRange } from "../../server/observability/metrics-dao.ts";
import { listRepos } from "../../server/observability/registry.ts";

let defaultDao: ReturnType<typeof createMetricsDao> | null = null;

export function createObservabilityRouter(dao = getDefaultDao()): Hono {
  const router = new Hono();
  router.get("/summary", (c) => c.json(dao.summary(parseRange(c.req.query("range")))));
  return router;
}

function getDefaultDao() {
  if (!defaultDao) defaultDao = createMetricsDao(createAttachPool(listRepos()));
  return defaultDao;
}

function parseRange(value: string | undefined): TimeRange {
  return value === "30d" ? "30d" : value === "all" ? "all" : "7d";
}
