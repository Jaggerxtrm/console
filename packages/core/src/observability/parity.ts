import { clearInterval, setInterval } from "node:timers";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createAttachPool } from "./attach-pool.ts";
import { createObservabilityDao } from "./dao.ts";
import { listRepos } from "./registry.ts";
import { makeLogEntry, type LogEntry } from "../runtime/logs.ts";
import type { SpecialistJob } from "./types.ts";

export type ParitySeverity = "info" | "warn" | "error";
export type ParityDiffKind = "missing_row" | "extra_row" | "field_delta" | "ordering";
export type ParityCheckName = "inFlightJobs" | "jobsByBead" | "recentJobs";
export type ParityDiff = {
  kind: ParityDiffKind;
  check: ParityCheckName;
  scope: string;
  severity: ParitySeverity;
  path?: string;
  live?: unknown;
  shadow?: unknown;
};

export type ParitySummary = {
  started_at: string;
  finished_at: string;
  parity_ok_count: number;
  diff_count: number;
  checks: Record<string, { live: number; shadow: number; diffs: number }>;
  diffs: ParityDiff[];
};

export type ParityDao = {
  jobsByBead(beadId: string): SpecialistJob[];
  inFlightJobs(): SpecialistJob[];
  recentJobs(limit: number): SpecialistJob[];
};

export type ParityHarness = {
  start(): void;
  stop(): void;
  tick(): Promise<ParitySummary>;
  runOnce(): Promise<ParitySummary>;
  getLatestSummary(): ParitySummary | null;
  getParityOkCount(): number;
};

const DEFAULT_INTERVAL_MS = 30_000;
const MAX_REPORTED_DIFFS = 50;

export function createObservabilityParityHarness(
  xtrmDb: Database | null,
  options: { intervalMs?: number; enabled?: boolean; liveDao?: ParityDao; shadowDao?: ParityDao; emitLog?: (entry: LogEntry) => void } = {},
): ParityHarness {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const enabled = options.enabled ?? Boolean(xtrmDb || options.shadowDao);
  const liveDao = options.liveDao ?? createObservabilityDao(createAttachPool(listRepos()));
  const shadowDao = options.shadowDao ?? (xtrmDb ? createShadowDao(xtrmDb) : null);
  const emitLog = options.emitLog ?? (() => {});
  const reportError = (error: unknown): void => {
    emitLog(makeLogEntry("system", "parity.observability", "error", "parity run failed", { error: error instanceof Error ? error.message : String(error) }));
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let latestSummary: ParitySummary | null = null;
  let parityOkCount = 0;

  async function tick(): Promise<ParitySummary> {
    const started_at = new Date().toISOString();
    const diffs: ParityDiff[] = [];
    const checks: ParitySummary["checks"] = {};

    const liveInFlight = liveDao.inFlightJobs();
    const shadowInFlight = shadowDao?.inFlightJobs() ?? [];
    compareJobLists("inFlightJobs", "all", liveInFlight, shadowInFlight, diffs, checks, true);

    const beadIds = unionStrings([
      ...liveInFlight.map((job) => job.beadId),
      ...shadowInFlight.map((job) => job.beadId),
      ...liveDao.recentJobs(100).map((job) => job.beadId),
      ...(shadowDao?.recentJobs(100).map((job) => job.beadId) ?? []),
    ]);

    for (const beadId of beadIds) {
      compareJobLists("jobsByBead", beadId, liveDao.jobsByBead(beadId), shadowDao?.jobsByBead(beadId) ?? [], diffs, checks, true);
    }

    compareJobLists("recentJobs", "100", liveDao.recentJobs(100), shadowDao?.recentJobs(100) ?? [], diffs, checks, true);

    const diff_count = diffs.length;
    if (diff_count === 0) parityOkCount += 1;
    const summary: ParitySummary = {
      started_at,
      finished_at: new Date().toISOString(),
      parity_ok_count: parityOkCount,
      diff_count,
      checks,
      diffs: diffs.slice(0, MAX_REPORTED_DIFFS),
    };
    latestSummary = summary;

    emitLog(makeLogEntry("system", "parity.observability", diff_count === 0 ? "info" : "warn", undefined, {
      severity: diff_count === 0 ? "info" : "warn",
      diff_count,
      parity_ok_count: parityOkCount,
      checks,
      diffs: summary.diffs,
    }));
    for (const diff of summary.diffs) emitLog(makeLogEntry("system", "parity.observability", diff.severity, undefined, diff));
    return summary;
  }

  function start(): void {
    if (!enabled || timer) return;
    void tick().catch(reportError);
    timer = setInterval(() => {
      void tick().catch(reportError);
    }, intervalMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    runOnce: tick,
    getLatestSummary: () => latestSummary,
    getParityOkCount: () => parityOkCount,
  };
}

function createShadowDao(db: Database) {
  return {
    jobsByBead(beadId: string): SpecialistJob[] {
      return readJobs(db, `WHERE bead_id = ?`, [beadId], false);
    },
    inFlightJobs(): SpecialistJob[] {
      return readJobs(db, `WHERE status IN ('starting','running','waiting')`, [], false);
    },
    recentJobs(limit: number): SpecialistJob[] {
      return readJobs(db, `WHERE status IN ('done','error','cancelled') ORDER BY datetime(updated_at) DESC LIMIT ?`, [limit], true);
    },
  };
}

function readJobs(db: Database, whereSql: string, params: SQLQueryBindings[], alreadyOrdered: boolean): SpecialistJob[] {
  const rows = db.prepare(`SELECT repo_slug, job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at, specialist, last_output FROM specialist_jobs ${whereSql}`).all(...params) as Array<Record<string, unknown>>;
  const jobs = rows.map(mapRow);
  return alreadyOrdered ? jobs : jobs.slice().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function mapRow(row: Record<string, unknown>): SpecialistJob {
  return {
    jobId: row.job_id == null ? null : String(row.job_id),
    repoSlug: String(row.repo_slug ?? ""),
    beadId: String(row.bead_id ?? ""),
    chainId: row.chain_id == null ? null : String(row.chain_id),
    epicId: row.epic_id == null ? null : String(row.epic_id),
    chainKind: row.chain_kind == null ? null : String(row.chain_kind),
    status: String(row.status ?? ""),
    updatedAt: normalizeUpdatedAt(row.updated_at),
    specialist: row.specialist == null ? null : String(row.specialist),
    lastOutput: row.last_output == null ? null : String(row.last_output),
    turns: null,
    tools: null,
    model: null,
  };
}

function normalizeUpdatedAt(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

export function compareParityJobs(
  check: ParityCheckName,
  scope: string,
  live: readonly SpecialistJob[],
  shadow: readonly SpecialistJob[],
  compareOrder = false,
): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  const checks: ParitySummary["checks"] = {};
  compareJobLists(check, scope, live, shadow, diffs, checks, compareOrder);
  return diffs;
}

function compareJobLists(
  check: ParityCheckName,
  scope: string,
  live: readonly SpecialistJob[],
  shadow: readonly SpecialistJob[],
  diffs: ParityDiff[],
  checks: ParitySummary["checks"],
  compareOrder: boolean,
): void {
  const bucketKey = `${check}:${scope}`;
  checks[bucketKey] = { live: live.length, shadow: shadow.length, diffs: 0 };

  const liveMap = new Map(live.map((job) => [jobKey(job), job]));
  const shadowMap = new Map(shadow.map((job) => [jobKey(job), job]));

  for (const [key, liveJob] of liveMap) {
    const shadowJob = shadowMap.get(key);
    if (!shadowJob) {
      pushDiff(diffs, checks, check, scope, "missing_row", "warn", key, liveJob, null);
      continue;
    }
    const delta = diffJob(liveJob, shadowJob);
    if (delta) pushDiff(diffs, checks, check, scope, "field_delta", "warn", `${key}.${delta.path}`, delta.live, delta.shadow);
  }

  for (const [key, shadowJob] of shadowMap) {
    if (!liveMap.has(key)) pushDiff(diffs, checks, check, scope, "extra_row", "warn", key, null, shadowJob);
  }

  if (compareOrder && !sameOrder(live, shadow)) {
    pushDiff(diffs, checks, check, scope, "ordering", "error", "order", live.map(jobKey), shadow.map(jobKey));
  }
}

function diffJob(live: SpecialistJob, shadow: SpecialistJob): { path: string; live: unknown; shadow: unknown } | null {
  const fields: Array<keyof SpecialistJob> = ["jobId", "repoSlug", "beadId", "chainId", "epicId", "chainKind", "status", "updatedAt", "specialist", "lastOutput", "turns", "tools", "model"];
  for (const field of fields) {
    if (!sameValue(live[field], shadow[field])) return { path: field, live: live[field], shadow: shadow[field] };
  }
  return null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOrder(left: readonly SpecialistJob[], right: readonly SpecialistJob[]): boolean {
  return left.map(jobKey).join("|") === right.map(jobKey).join("|");
}

function jobKey(job: SpecialistJob): string {
  return [job.repoSlug, job.jobId ?? "", job.beadId, job.status, job.updatedAt].join("::");
}

function pushDiff(
  diffs: ParityDiff[],
  checks: ParitySummary["checks"],
  check: ParityCheckName,
  scope: string,
  kind: ParityDiffKind,
  severity: ParitySeverity,
  path: string,
  live: unknown,
  shadow: unknown,
): void {
  diffs.push({ check, scope, kind, severity, path, live, shadow });
  checks[`${check}:${scope}`].diffs += 1;
}

function unionStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
