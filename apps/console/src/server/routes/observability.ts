import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  createAttachPool,
  createMetricsDao,
  listRepos,
  type TimeRange,
} from "../../../../../packages/core/src/observability/index.ts";

export type ObservabilityMetricsDao = ReturnType<typeof createMetricsDao>;

let defaultDao: ObservabilityMetricsDao | null = null;

export function createObservabilityRouter(dao?: ObservabilityMetricsDao, xtrmDb?: Database | null): Hono {
  const router = new Hono();
  const resolvedDao = dao
    ?? (xtrmDb && hasMaterializedMetrics(xtrmDb) ? createMetricsDao(singleDbPool(xtrmDb)) : getDefaultDao());

  router.get("/summary", (c) => {
    const summary = resolvedDao.summary(parseRange(c.req.query("range")));
    const coverage = "coverage" in resolvedDao
      ? (resolvedDao as { coverage?: () => ObservabilityCoverage }).coverage?.()
      : undefined;
    return c.json({
      ...summary,
      coverage,
      source_health: coverage && coverage.skipped.length > 0
        ? { source: "observability", status: "degraded", metadata: { coverage } }
        : { source: "observability", status: "fresh", metadata: {} },
    });
  });

  return router;
}

interface ObservabilityCoverage {
  attached: string[];
  skipped: Array<{ slug: string; reason: string }>;
  totalDiscovered: number;
}

function getDefaultDao(): ObservabilityMetricsDao {
  if (!defaultDao) defaultDao = createMetricsDao(createAttachPool(listRepos()));
  return defaultDao;
}

function singleDbPool(db: Database) {
  return {
    withAttached<T>(fn: (database: Database, attached: ReadonlyArray<{ alias: string; slug: string }>) => T): T {
      return fn(db, [{ alias: "main", slug: "xtrm" }]);
    },
    getCoverage(): ObservabilityCoverage {
      return { attached: ["xtrm"], skipped: [], totalDiscovered: 1 };
    },
  };
}

function hasMaterializedMetrics(db: Database): boolean {
  for (const table of ["specialist_jobs", "specialist_job_metrics", "specialist_results"]) {
    const row = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present?: number } | null;
    if (row?.present !== 1) return false;
  }
  return true;
}

function parseRange(value: string | undefined): TimeRange {
  return value === "30d" ? "30d" : value === "all" ? "all" : "7d";
}
