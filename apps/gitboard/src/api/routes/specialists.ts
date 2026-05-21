import { Hono } from "hono";
import { createAttachPool } from "../../server/observability/attach-pool.ts";
import { createObservabilityDao } from "../../server/observability/dao.ts";
import { get as getEpoch } from "../../server/observability/epoch.ts";
import { listRepos } from "../../server/observability/registry.ts";
import type { RepoEntry } from "../../server/observability/registry.ts";
import type { AttachPoolLike, SpecialistChain, SpecialistJob } from "../../server/observability/types.ts";

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
  expiresAt: number;
};

let defaultBundle: DefaultDaoBundle | null = null;
const DEFAULT_DAO_TTL_MS = 30_000;
const LIVE_JOBS_CACHE_TTL_MS = 500;
const DETAIL_CACHE_TTL_MS = 1_000;

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

  router.get("/jobs", (c) => {
    const beadId = c.req.query("bead_id");
    if (!beadId) {
      return c.json({ error: "Missing bead_id" }, 400);
    }

    const current = resolve();
    const key = cacheKey("jobs", current.repos, epochGetter, beadId);
    const cached = readCache(jobsByBeadCache, key);
    if (cached) return c.json(cached);

    const value = { jobs: current.dao.jobsByBead(beadId) };
    jobsByBeadCache = writeCache(key, value, DETAIL_CACHE_TTL_MS);
    return c.json(value);
  });

  router.get("/jobs/in-flight", (c) => {
    const limit = parseLimit(c.req.query("limit"), 50);
    const current = resolve();
    const key = cacheKey("in-flight", current.repos, epochGetter, String(limit));
    const cached = readCache(inFlightCache, key);
    if (cached) return c.json(cached);

    const inFlight = current.dao.inFlightJobs().slice(0, 200);
    const recentHistory = current.dao.recentJobs(limit).slice(0, limit);
    const epoch = repoEpochs(current.repos, epochGetter);
    const value = { in_flight: inFlight, recent_history: recentHistory, jobs: inFlight, epoch };
    inFlightCache = writeCache(key, value, LIVE_JOBS_CACHE_TTL_MS);
    return c.json(value);
  });

  router.get("/chains/:chain_id", (c) => {
    const chainId = c.req.param("chain_id");
    const current = resolve();
    const key = cacheKey("chain", current.repos, epochGetter, chainId);
    const cached = readCache(chainCache, key);
    const value = cached ?? { chain: { jobs: current.dao.chainById(chainId) } };
    if (!cached) chainCache = writeCache(key, value, DETAIL_CACHE_TTL_MS);
    if (value.chain.jobs.length === 0) {
      return c.json({ error: "Chain not found" }, 404);
    }

    return c.json(value);
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
  if (!entry || entry.key !== key || entry.expiresAt <= Date.now()) return null;
  return entry.value;
}

function writeCache<T>(key: string, value: T, ttlMs: number): CachedValue<T> {
  return { key, value, expiresAt: Date.now() + ttlMs };
}

function getDefaultBundle(repoLister: () => SpecialistRepoList, epochGetter: (repoSlug: string) => number): DefaultDaoBundle {
  const now = Date.now();
  const repos = repoLister();
  const key = cacheKey("bundle", repos, epochGetter);
  if (defaultBundle && defaultBundle.key === key && now - defaultBundle.createdAt < DEFAULT_DAO_TTL_MS) return defaultBundle;

  const pool: AttachPoolLike = createAttachPool(repos);
  defaultBundle = { dao: createObservabilityDao(pool), repos: summarizeRepos(repos), createdAt: now, key };
  return defaultBundle;
}
