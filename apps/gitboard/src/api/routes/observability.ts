import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createMetricsDao, type TimeRange } from "../../server/observability/metrics-dao.ts";
import { listRepos } from "../../server/observability/registry.ts";

let defaultDao: ReturnType<typeof createMetricsDao> | null = null;

export function createObservabilityRouter(dao?: ReturnType<typeof createMetricsDao>, xtrmDb?: Database): Hono {
  const router = new Hono();
  const resolvedDao = xtrmDb ? createMetricsDao(singleDbPool(xtrmDb)) : (dao ?? getDefaultDao());
  router.get("/summary", (c) => {
    const summary = resolvedDao.summary(parseRange(c.req.query("range")));
    const coverage = "coverage" in resolvedDao ? (resolvedDao as { coverage?: () => { attached: string[]; skipped: Array<{ slug: string; reason: string }>; totalDiscovered: number } }).coverage?.() : undefined;
    return c.json({ ...summary, coverage, source_health: coverage && coverage.skipped.length > 0 ? { source: "observability", status: "degraded", metadata: { coverage } } : { source: "observability", status: "fresh", metadata: {} } });
  });
  return router;
}

function getDefaultDao() {
  if (!defaultDao) defaultDao = createMetricsDao(createAttachPool(listRepos()));
  return defaultDao;
}

function singleDbPool(db: Database) {
  return {
    withAttached<T>(fn: (db: Database, attached: ReadonlyArray<{ alias: string; slug: string }>) => T): T {
      return fn(db, [{ alias: "xtrm", slug: "xtrm" }]);
    },
    getCoverage() {
      return { attached: ["xtrm"], skipped: [], totalDiscovered: 1 };
    },
  };
}

function parseRange(value: string | undefined): TimeRange {
  return value === "30d" ? "30d" : value === "all" ? "all" : "7d";
}
