import { Hono } from "hono";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../server/observability/dao.ts";
import { get as getEpoch } from "../../server/observability/epoch.ts";
import { listRepos } from "../../server/observability/registry.ts";
import type { AttachPoolLike, SpecialistChain, SpecialistJob } from "../../server/observability/types.ts";

export interface SpecialistsDao {
  jobsByBead(beadId: string): SpecialistJob[];
  inFlightJobs(): SpecialistJob[];
  recentJobs(limit: number): SpecialistJob[];
  chainById(chainId: string): SpecialistChain[];
}

let defaultDao: SpecialistsDao | null = null;

export interface SpecialistsRouterOptions {
  listRepos?: () => ReadonlyArray<{ repoSlug: string }>;
  getEpoch?: (repoSlug: string) => number;
}

export function createSpecialistsRouter(
  dao: SpecialistsDao = getDefaultDao(),
  options: SpecialistsRouterOptions = {},
): Hono {
  const router = new Hono();
  const repoLister = options.listRepos ?? listRepos;
  const epochGetter = options.getEpoch ?? getEpoch;

  router.get("/jobs", (c) => {
    const beadId = c.req.query("bead_id");
    if (!beadId) {
      return c.json({ error: "Missing bead_id" }, 400);
    }

    return c.json({ jobs: dao.jobsByBead(beadId) });
  });

  router.get("/jobs/in-flight", (c) => {
    const limit = parseLimit(c.req.query("limit"), 50);
    const inFlight = dao.inFlightJobs().slice(0, 200);
    const recentHistory = dao.recentJobs(limit).slice(0, limit);
    const epoch = Object.fromEntries(repoLister().map((repo) => [repo.repoSlug, epochGetter(repo.repoSlug)]));
    return c.json({ in_flight: inFlight, recent_history: recentHistory, jobs: inFlight, epoch });
  });

  router.get("/chains/:chain_id", (c) => {
    const chainId = c.req.param("chain_id");
    const jobs = dao.chainById(chainId);
    if (jobs.length === 0) {
      return c.json({ error: "Chain not found" }, 404);
    }

    return c.json({ chain: { jobs } });
  });

  return router;
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 200) : fallback;
}

function getDefaultDao(): SpecialistsDao {
  if (!defaultDao) {
    const pool: AttachPoolLike = createAttachPool(listRepos());
    defaultDao = createObservabilityDao(pool);
  }

  return defaultDao;
}
