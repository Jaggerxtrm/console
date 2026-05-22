import { Hono } from "hono";
import { emit, makeLogEntry } from "../../core/logger.ts";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../server/observability/dao.ts";
import { get as getEpoch } from "../../server/observability/epoch.ts";
import { listRepos } from "../../server/observability/registry.ts";
import type { RepoEntry } from "../../server/observability/registry.ts";
import type { AttachPoolLike, SpecialistChain, SpecialistJob } from "../../server/observability/types.ts";
import { makeSourceHealth } from "../../types/source-health.ts";

export interface SpecialistsDao {
  jobsByBead(beadId: string): SpecialistJob[];
  inFlightJobs(): SpecialistJob[];
  recentJobs(limit: number): SpecialistJob[];
  chainById(chainId: string): SpecialistChain[];
}

type SpecialistRepoSummary = ReadonlyArray<Pick<RepoEntry, "repoSlug">>;
type SpecialistRepoList = ReadonlyArray<RepoEntry>;

type DefaultDaoBundle = {
  dao: SpecialistsDao;
  repos: SpecialistRepoSummary;
  createdAt: number;
  key: string;
};

type CachedValue<T> = {
  key: string;
  value: T;
  refreshedAt: number;
};

let defaultBundle: DefaultDaoBundle | null = null;
let defaultBundleWarm: Promise<void> | null = null;
const DEFAULT_DAO_REFRESH_MS = 30_000;
const ROUTE_WARM_TIMEOUT_MS = 750;

export interface SpecialistsRouterOptions {
  listRepos?: () => SpecialistRepoList;
  getEpoch?: (repoSlug: string) => number;
}

export function createSpecialistsRouter(
  dao?: SpecialistsDao,
  options: SpecialistsRouterOptions = {},
): Hono {
  const router = new Hono();
  const repoLister = options.listRepos ?? listRepos;
  const epochGetter = options.getEpoch ?? getEpoch;
  const resolve = () => dao
    ? { dao, repos: summarizeRepos(repoLister()) }
    : getDefaultBundle(repoLister, epochGetter);
  let jobsByBeadCache: CachedValue<{ jobs: SpecialistJob[] }> | null = null;
  let inFlightCache: CachedValue<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> }> | null = null;
  let chainCache: CachedValue<{ chain: { jobs: SpecialistChain[] } }> | null = null;

  router.get("/jobs", async (c) => {
    const beadId = c.req.query("bead_id");
    if (!beadId) {
      return c.json({ error: "Missing bead_id" }, 400);
    }

    const current = resolve();
    const key = cacheKey("jobs", current.repos, epochGetter, beadId);
    const cached = readCache(jobsByBeadCache, key);
    if (cached) {
      emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "jobs", hit: true }));
      return c.json({ ...cached, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }

    emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "jobs", hit: false }));
    const refreshed = await withTimeout(refreshJobsByBead(current.dao, beadId, key), ROUTE_WARM_TIMEOUT_MS);
    if (refreshed) {
      jobsByBeadCache = refreshed;
      return c.json({ ...refreshed.value, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }
    return c.json({ jobs: [], freshness: "stale", source_health: makeSourceHealth("specialists", "stale") });
  });

  router.get("/jobs/in-flight", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 50);
    const current = resolve();
    const key = cacheKey("in-flight", current.repos, epochGetter, String(limit));
    const cached = readCache(inFlightCache, key);
    if (cached) {
      emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "in-flight", hit: true }));
      return c.json({ ...cached, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }

    emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "in-flight", hit: false }));
    const refreshed = await withTimeout(refreshInFlight(current.dao, current.repos, epochGetter, limit, key), ROUTE_WARM_TIMEOUT_MS);
    if (refreshed) {
      inFlightCache = refreshed;
      return c.json({ ...refreshed.value, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }
    return c.json({ in_flight: [], recent_history: [], jobs: [], epoch: repoEpochs(current.repos, epochGetter), freshness: "stale", source_health: makeSourceHealth("specialists", "stale") });
  });

  router.get("/chains/:chain_id", async (c) => {
    const chainId = c.req.param("chain_id");
    const current = resolve();
    const key = cacheKey("chain", current.repos, epochGetter, chainId);
    const cached = readCache(chainCache, key);
    if (cached) {
      emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "chains", hit: true }));
      if (cached.chain.jobs.length === 0) return c.json({ error: "Chain not found" }, 404);
      return c.json({ ...cached, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }

    emit(makeLogEntry("api", "specialists.cache", "info", undefined, { route: "chains", hit: false }));
    const refreshed = await withTimeout(refreshChain(current.dao, chainId, key), ROUTE_WARM_TIMEOUT_MS);
    if (refreshed) {
      chainCache = refreshed;
      if (refreshed.value.chain.jobs.length === 0) return c.json({ error: "Chain not found" }, 404);
      return c.json({ ...refreshed.value, freshness: "fresh", source_health: makeSourceHealth("specialists", "fresh") });
    }
    return c.json({ chain: { jobs: [] }, freshness: "stale", source_health: makeSourceHealth("specialists", "stale") });
  });

  return router;
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 200) : fallback;
}

function summarizeRepos(repos: SpecialistRepoList): SpecialistRepoSummary {
  return repos.map((repo) => ({ repoSlug: repo.repoSlug }));
}

function repoEpochs(repos: SpecialistRepoSummary, epochGetter: (repoSlug: string) => number): Record<string, number> {
  return Object.fromEntries(repos.map((repo) => [repo.repoSlug, epochGetter(repo.repoSlug)]));
}

function cacheKey(prefix: string, repos: SpecialistRepoSummary, epochGetter: (repoSlug: string) => number, ...parts: string[]): string {
  const repoPart = repos.map((repo) => `${repo.repoSlug}:${epochGetter(repo.repoSlug)}`).sort().join("|");
  return `${prefix}:${parts.join(":")}:${repoPart}`;
}

function readCache<T>(entry: CachedValue<T> | null, key: string): T | null {
  if (!entry || entry.key !== key) return null;
  return entry.value;
}

function writeCache<T>(key: string, value: T): CachedValue<T> {
  return { key, value, refreshedAt: Date.now() };
}

async function refreshJobsByBead(dao: SpecialistsDao, beadId: string, key: string): Promise<CachedValue<{ jobs: SpecialistJob[] }>> {
  const value = { jobs: dao.jobsByBead(beadId) };
  return writeCache(key, value);
}

async function refreshInFlight(
  dao: SpecialistsDao,
  repos: SpecialistRepoSummary,
  epochGetter: (repoSlug: string) => number,
  limit: number,
  key: string,
): Promise<CachedValue<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> }>> {
  const refreshableDao = dao as SpecialistsDao & { refreshInFlight?: (limit: number) => Promise<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[] }> };
  const value = refreshableDao.refreshInFlight
    ? await refreshableDao.refreshInFlight(limit)
    : (() => {
        const inFlight = dao.inFlightJobs().slice(0, 200);
        return {
          in_flight: inFlight,
          recent_history: dao.recentJobs(limit).slice(0, limit),
          jobs: inFlight,
        };
      })();
  return writeCache(key, { ...value, epoch: repoEpochs(repos, epochGetter) });
}

async function refreshChain(dao: SpecialistsDao, chainId: string, key: string): Promise<CachedValue<{ chain: { jobs: SpecialistChain[] } }>> {
  return writeCache(key, { chain: { jobs: dao.chainById(chainId) } });
}

function getDefaultBundle(repoLister: () => SpecialistRepoList, epochGetter: (repoSlug: string) => number): DefaultDaoBundle {
  const now = Date.now();
  const repos = repoLister();
  const key = cacheKey("bundle", repos, epochGetter);
  if (defaultBundle && defaultBundle.key === key) return defaultBundle;

  void warmDefaultBundle(repos, key);
  if (defaultBundle) return defaultBundle;
  return { dao: emptySpecialistsDao(), repos: summarizeRepos(repos), createdAt: now, key };
}

async function warmDefaultBundle(repos: SpecialistRepoList, key: string): Promise<void> {
  if (defaultBundleWarm) return;
  defaultBundleWarm = Promise.resolve().then(() => {
    const pool: AttachPoolLike = createAttachPool(repos);
    defaultBundle = { dao: createObservabilityDao(pool), repos: summarizeRepos(repos), createdAt: Date.now(), key };
  }).catch(() => undefined).finally(() => { defaultBundleWarm = null; });
  await defaultBundleWarm;
}

function emptySpecialistsDao(): SpecialistsDao {
  return { jobsByBead: () => [], inFlightJobs: () => [], recentJobs: () => [], chainById: () => [] };
}


async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
