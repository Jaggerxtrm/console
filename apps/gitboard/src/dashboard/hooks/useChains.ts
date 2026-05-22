import { useMemo } from "react";
import type { SpecialistJob } from "../../server/observability/types.ts";
import { useDashboardResource, useDashboardResourceInvalidation } from "../lib/resource.ts";

interface ChainsResponse {
  in_flight?: Array<SpecialistJob & { lastOutput?: string | null; last_output?: string | null }>;
  recent_history?: Array<SpecialistJob & { lastOutput?: string | null; last_output?: string | null }>;
}

const POLL_MS = 5000;

export type ChainStatus = "running" | "waiting" | "done" | "error" | "cancelled";

export interface ChainJob extends SpecialistJob {
  lastOutput: string | null;
  turns: number | null;
  tools: number | null;
  model: string | null;
}

export interface ChainSummary {
  chainId: string;
  rootBeadId: string;
  title: string;
  jobs: ChainJob[];
  status: ChainStatus;
  roles: Array<{ role: string; status: string }>;
  elapsedMs: number;
  lastMessage: string;
  lastUpdatedAt: string;
}

export interface UseChainsState {
  chains: ChainSummary[];
  loading: boolean;
  error: string | null;
}

export function useChains(): UseChainsState {
  const resource = useDashboardResource<ChainsResponse>({
    key: "specialists:chains",
    cacheTtlMs: POLL_MS,
    pollMs: POLL_MS,
    fetcher: async (_key, _options) => {
      const res = await fetch("/api/specialists/jobs/in-flight?limit=200");
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      return res.json() as Promise<ChainsResponse>;
    },
  });

  useDashboardResourceInvalidation("specialists:activity", "specialists:chains");

  const jobs = useMemo(() => normalizeJobs([...(resource.data?.in_flight ?? []), ...(resource.data?.recent_history ?? [])]), [resource.data]);
  const chains = useMemo(() => groupChains(jobs), [jobs]);
  return { chains, loading: resource.loading, error: resource.error };
}

function normalizeJobs(jobs: Array<SpecialistJob & { lastOutput?: string | null; last_output?: string | null }>): ChainJob[] {
  return jobs.map((job) => ({ ...job, lastOutput: job.lastOutput ?? job.last_output ?? null }));
}

function groupChains(jobs: ChainJob[]): ChainSummary[] {
  const byChain = new Map<string, ChainJob[]>();
  for (const job of jobs) {
    if (!job.chainId) continue;
    const bucket = byChain.get(job.chainId);
    if (bucket) bucket.push(job);
    else byChain.set(job.chainId, [job]);
  }

  return [...byChain.entries()].map(([chainId, chainJobs]) => {
    const ordered = [...chainJobs].sort(compareJobs);
    const latest = ordered[ordered.length - 1]!;
    const earliest = ordered[0]!;
    return {
      chainId,
      rootBeadId: earliest.beadId,
      title: chainId,
      jobs: ordered,
      status: pickStatus(ordered),
      roles: buildRoles(ordered),
      elapsedMs: Math.max(0, Date.parse(latest.updatedAt) - Date.parse(earliest.updatedAt)),
      lastMessage: excerpt(latest.lastOutput),
      lastUpdatedAt: latest.updatedAt,
    };
  }).sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
}

function buildRoles(jobs: ChainJob[]): Array<{ role: string; status: string }> {
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const role = job.specialist ?? job.chainKind ?? "unknown";
    if (!seen.has(role)) seen.set(role, job.status);
  }
  return [...seen.entries()].map(([role, status]) => ({ role, status }));
}

function pickStatus(jobs: ChainJob[]): ChainStatus {
  const active = [...jobs].reverse().find((job) => job.status === "running" || job.status === "waiting");
  if (active) return active.status as ChainStatus;
  const latest = jobs[jobs.length - 1]?.status ?? "done";
  if (latest === "error" || latest === "cancelled" || latest === "done") return latest;
  return "done";
}

function compareJobs(a: ChainJob, b: ChainJob): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
}

function excerpt(value: string | null): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
