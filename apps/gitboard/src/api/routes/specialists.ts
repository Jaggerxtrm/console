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

const CACHE_TTL_MS = 5000;

type MaterializationStateRow = {
  source_key: string;
  last_status: string | null;
  last_success_at: string | null;
};

type XtrmSpecialistsDao = SpecialistsDao & {
  inFlightWithRecent(limit: number): { in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> };
  materializationState(): MaterializationStateRow[];
};

let defaultBundle: DefaultDaoBundle | null = null;
let defaultBundleWarm: { key: string; promise: Promise<void> } | null = null;

export interface SpecialistsRouterOptions {
  listRepos?: () => SpecialistRepoList;
  getEpoch?: (repoSlug: string) => number;
}

export function createSpecialistsRouter(
  dao?: SpecialistsDao,
  xtrmDb?: import("bun:sqlite").Database | SpecialistsRouterOptions,
  options: SpecialistsRouterOptions = {},
): Hono {
  const router = new Hono();
  const resolvedOptions = isSpecialistsRouterOptions(xtrmDb) ? xtrmDb : options;
  const xtrmDatabase = isSpecialistsRouterOptions(xtrmDb) ? undefined : xtrmDb;
  const repoLister = resolvedOptions.listRepos ?? listRepos;
  const epochGetter = resolvedOptions.getEpoch ?? getEpoch;
  const xtrmDao = xtrmDatabase ? createXtrmSpecialistsDao(xtrmDatabase, repoLister, epochGetter) : null;
  const liveFallbackEnabled = process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK === "1";
  const getSourceHealth = () => {
    if (dao) return makeSourceHealth("specialists", "fresh", { metadata: {} });
    return sourceHealthFromState(xtrmDao?.materializationState());
  };
  const resolve = () => {
    if (dao) return { dao, repos: summarizeRepos(repoLister()) };
    if (!xtrmDao) return getDefaultBundle(repoLister, epochGetter);
    if (liveFallbackEnabled) return { dao: xtrmDao, repos: summarizeRepos(repoLister()) };
    return hasSuccessfulObsMaterialization(xtrmDao.materializationState())
      ? { dao: xtrmDao, repos: summarizeRepos(repoLister()) }
      : getDefaultBundle(repoLister, epochGetter);
  };
  let jobsByBeadCache: CachedValue<{ jobs: SpecialistJob[] }> | null = null;
  let inFlightCache: CachedValue<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> }> | null = null;
  let chainCache: CachedValue<{ chain: { jobs: SpecialistChain[] } }> | null = null;

  router.get("/jobs", async (c) => {
    const startedAt = performance.now();
    const beadId = c.req.query("bead_id");
    if (!beadId) return c.json({ error: "Missing bead_id" }, 400);

    const current = resolve();
    const key = cacheKey("jobs", current.repos, epochGetter, beadId);
    const cached = readCache(jobsByBeadCache, key);
    if (cached) {
      logJobsByBeadResponse(beadId, cached.jobs, "cache", startedAt);
      return c.json({ ...cached, freshness: "fresh", source_health: getSourceHealth() });
    }

    const refreshed = await refreshJobsByBead(current.dao, beadId, key);
    jobsByBeadCache = refreshed;
    logJobsByBeadResponse(beadId, refreshed.value.jobs, "fresh", startedAt);
    return c.json({ ...refreshed.value, freshness: "fresh", source_health: getSourceHealth() });
  });

  router.get("/jobs/in-flight", async (c) => {
    const startedAt = performance.now();
    const limit = parseLimit(c.req.query("limit"), 50);
    const current = resolve();
    const key = cacheKey("in-flight", current.repos, epochGetter, String(limit));
    const cached = readCache(inFlightCache, key);
    if (cached) {
      logInFlightResponse(cached.jobs, cached.recent_history, cached.epoch, "cache", startedAt);
      return c.json({ ...cached, freshness: "fresh", source_health: getSourceHealth() });
    }

    const refreshed = await refreshInFlight(current.dao, current.repos, epochGetter, limit, key);
    inFlightCache = refreshed;
    logInFlightResponse(refreshed.value.jobs, refreshed.value.recent_history, refreshed.value.epoch, "fresh", startedAt);
    return c.json({ ...refreshed.value, freshness: "fresh", source_health: getSourceHealth() });
  });

  router.get("/chains/:chain_id", async (c) => {
    const chainId = c.req.param("chain_id");
    const current = resolve();
    const key = cacheKey("chain", current.repos, epochGetter, chainId);
    const cached = readCache(chainCache, key);
    if (cached) {
      if (cached.chain.jobs.length === 0) return c.json({ error: "Chain not found" }, 404);
      return c.json({ ...cached, freshness: "fresh", source_health: getSourceHealth() });
    }

    const refreshed = await refreshChain(current.dao, chainId, key);
    chainCache = refreshed;
    if (refreshed.value.chain.jobs.length === 0) return c.json({ error: "Chain not found" }, 404);
    return c.json({ ...refreshed.value, freshness: "fresh", source_health: getSourceHealth() });
  });

  return router;
}

function getSourceHealth() {
  return makeSourceHealth("specialists", "fresh", { metadata: {} });
}

function sourceHealthFromState(rows: MaterializationStateRow[] | undefined) {
  if (!rows || rows.length === 0) return makeSourceHealth("specialists", "degraded", { metadata: {} });
  if (rows.some((row) => row.last_status === "error")) return makeSourceHealth("specialists", "unhealthy", { metadata: summarizeMaterializationState(rows) });
  if (rows.every((row) => row.last_status === "success")) return makeSourceHealth("specialists", "fresh", { metadata: summarizeMaterializationState(rows) });
  return makeSourceHealth("specialists", "degraded", { metadata: summarizeMaterializationState(rows) });
}

function summarizeMaterializationState(rows: MaterializationStateRow[]): Record<string, unknown> {
  const latest = rows.filter((row) => row.source_key.startsWith("obs:")).sort((left, right) => Date.parse(right.last_success_at ?? "") - Date.parse(left.last_success_at ?? ""))[0];
  return latest ? { source_key: latest.source_key, last_status: latest.last_status, last_success_at: latest.last_success_at } : {};
}

function hasSuccessfulObsMaterialization(rows: MaterializationStateRow[]): boolean {
  return rows.some((row) => row.source_key.startsWith("obs:") && row.last_status === "success");
}

function createXtrmSpecialistsDao(db: import("bun:sqlite").Database, repoLister: () => SpecialistRepoList, epochGetter: (repoSlug: string) => number): XtrmSpecialistsDao {
  return {
    jobsByBead: (beadId) => loadJobs(db, `WHERE l.issue_id = ?`, [beadId]),
    inFlightJobs: () => loadJobs(db, `WHERE j.status IN ("starting", "running", "waiting")`, []),
    recentJobs: (limit) => loadJobs(db, `WHERE j.status IN ("done", "error", "cancelled")`, []).slice(0, limit),
    chainById: (chainId) => loadJobs(db, `WHERE j.chain_id = ?`, [chainId]) as unknown as SpecialistChain[],
    inFlightWithRecent: (limit) => {
      const repos = summarizeRepos(repoLister());
      const epoch = repoEpochs(repos, epochGetter);
      const in_flight = loadJobs(db, `WHERE j.status IN ("starting", "running", "waiting")`, []);
      const recent_history = loadJobs(db, `WHERE j.status IN ("done", "error", "cancelled")`, []).slice(0, limit);
      return { in_flight, recent_history, jobs: in_flight, epoch };
    },
    materializationState: () => db.query("SELECT source_key, last_status, last_success_at FROM materialization_state").all() as MaterializationStateRow[],
  };
}

function loadJobs(db: import("bun:sqlite").Database, whereSql: string, params: readonly string[]): SpecialistJob[] {
  const rows = db.query(`
    SELECT j.repo_slug, j.job_id, COALESCE(l.issue_id, j.job_id) AS bead_id, j.chain_id, j.epic_id, j.chain_kind, j.status, j.updated_at, j.specialist, j.last_output,
      COALESCE((SELECT COUNT(*) FROM specialist_job_events e WHERE e.repo_slug = j.repo_slug AND e.job_id = j.job_id), 0) AS event_count,
      NULL AS turns, NULL AS tools, NULL AS model
    FROM specialist_jobs AS j
    LEFT JOIN substrate_job_link AS l ON l.repo_slug = j.repo_slug AND l.job_id = j.job_id
    ${whereSql}
    ORDER BY COALESCE(j.updated_at, '') DESC, j.job_id ASC
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapJobRow);
}

function mapJobRow(row: Record<string, unknown>): SpecialistJob {
  return {
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repo_slug),
    beadId: String(row.bead_id),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: row.turns == null ? null : Number(row.turns),
    tools: row.tools == null ? null : Number(row.tools),
    model: row.model == null ? null : String(row.model),
  };
}

function logJobsByBeadResponse(beadId: string, jobs: SpecialistJob[], freshness: string, startedAt: number): void {
  emit(makeLogEntry("api", "specialists.jobs_by_bead.response", "info", undefined, {
    beadId,
    freshness,
    ms: Math.round(performance.now() - startedAt),
    jobs: jobs.length,
    jobIds: jobs.slice(0, 50).map((job) => job.jobId),
    statuses: countStatuses(jobs),
    summaries: summarizeJobs(jobs),
  }));
}

function logInFlightResponse(
  jobs: SpecialistJob[],
  recentHistory: SpecialistJob[],
  epoch: Record<string, number>,
  freshness: string,
  startedAt: number,
): void {
  emit(makeLogEntry("api", "specialists.in_flight.response", "info", undefined, {
    freshness,
    ms: Math.round(performance.now() - startedAt),
    jobs: jobs.length,
    recentHistory: recentHistory.length,
    beadIds: [...new Set(jobs.map((job) => job.beadId))].slice(0, 50),
    repoSlugs: [...new Set(jobs.map((job) => job.repoSlug))].slice(0, 50),
    jobIds: jobs.slice(0, 50).map((job) => job.jobId),
    statuses: countStatuses(jobs),
    epoch,
    summaries: summarizeJobs(jobs),
  }));
}

function summarizeJobs(jobs: SpecialistJob[]): Array<Record<string, unknown>> {
  return jobs.slice(0, 50).map((job) => ({
    jobId: job.jobId,
    chainId: job.chainId,
    beadId: job.beadId,
    repoSlug: job.repoSlug,
    status: job.status,
    specialist: job.specialist,
    chainKind: job.chainKind,
    updatedAt: job.updatedAt,
  }));
}

function countStatuses(jobs: SpecialistJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return counts;
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
  if (Date.now() - entry.refreshedAt > CACHE_TTL_MS) return null;
  return entry.value;
}

function writeCache<T>(key: string, value: T): CachedValue<T> {
  return { key, value, refreshedAt: Date.now() };
}

function refreshJobsByBead(dao: SpecialistsDao, beadId: string, key: string): CachedValue<{ jobs: SpecialistJob[] }> {
  return writeCache(key, { jobs: dao.jobsByBead(beadId) });
}

async function refreshInFlight(
  dao: SpecialistsDao,
  repos: SpecialistRepoSummary,
  epochGetter: (repoSlug: string) => number,
  limit: number,
  key: string,
): Promise<CachedValue<{ in_flight: SpecialistJob[]; recent_history: SpecialistJob[]; jobs: SpecialistJob[]; epoch: Record<string, number> }>> {
  const value = "inFlightWithRecent" in dao
    ? (dao as XtrmSpecialistsDao).inFlightWithRecent(limit)
    : (() => {
        const inFlight = dao.inFlightJobs().slice(0, 200);
        return {
          in_flight: inFlight,
          recent_history: dao.recentJobs(limit).slice(0, limit),
          jobs: inFlight,
          epoch: repoEpochs(repos, epochGetter),
        };
      })();
  return writeCache(key, value);
}

function refreshChain(dao: SpecialistsDao, chainId: string, key: string): CachedValue<{ chain: { jobs: SpecialistChain[] } }> {
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
  if (defaultBundleWarm?.key === key) return;
  const promise = Promise.resolve().then(() => {
    const pool: AttachPoolLike = createAttachPool(repos);
    defaultBundle = { dao: createObservabilityDao(pool), repos: summarizeRepos(repos), createdAt: Date.now(), key };
  }).catch(() => undefined).finally(() => {
    if (defaultBundleWarm?.key === key) defaultBundleWarm = null;
  });
  defaultBundleWarm = { key, promise };
  await promise;
}

function emptySpecialistsDao(): SpecialistsDao {
  return { jobsByBead: () => [], inFlightJobs: () => [], recentJobs: () => [], chainById: () => [] };
}

function isSpecialistsRouterOptions(value: unknown): value is SpecialistsRouterOptions {
  return typeof value === "object" && value !== null && ("listRepos" in value || "getEpoch" in value);
}
