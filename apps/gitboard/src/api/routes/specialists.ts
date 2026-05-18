import { Hono } from "hono";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../server/observability/dao.ts";
import { get as getEpoch } from "../../server/observability/epoch.ts";
import { listRepos } from "../../server/observability/registry.ts";
import type { AttachPoolLike, SpecialistChain, SpecialistJob } from "../../server/observability/types.ts";

export interface SpecialistsDao {
  jobsByBead(beadId: string): SpecialistJob[];
  inFlightJobs(): SpecialistJob[];
  chainById(chainId: string): SpecialistChain[];
}

let defaultDao: SpecialistsDao | null = null;

export function createSpecialistsRouter(dao: SpecialistsDao = getDefaultDao()): Hono {
  const router = new Hono();

  router.get("/jobs", (c) => {
    const beadId = c.req.query("bead_id");
    if (!beadId) {
      return c.json({ error: "Missing bead_id" }, 400);
    }

    return c.json({ jobs: dao.jobsByBead(beadId) });
  });

  router.get("/jobs/in-flight", (c) => {
    const jobs = dao.inFlightJobs().slice(0, 200);
    const epoch = Object.fromEntries(listRepos().map((repo) => [repo.repoSlug, getEpoch(repo.repoSlug)]));
    return c.json({ jobs, epoch });
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

function getDefaultDao(): SpecialistsDao {
  if (!defaultDao) {
    const pool: AttachPoolLike = createAttachPool(listRepos());
    defaultDao = createObservabilityDao(pool);
  }

  return defaultDao;
}
