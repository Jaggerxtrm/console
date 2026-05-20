import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SpecialistJob } from "../../server/observability/types.ts";

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
  const [jobs, setJobs] = useState<ChainJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const visibleRef = useRef(typeof document === "undefined" ? true : document.visibilityState === "visible");

  useEffect(() => {
    const onVisibilityChange = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) void load();
      else if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  async function load() {
    if (!visibleRef.current) return;
    try {
      const res = await fetch("/api/specialists/jobs/in-flight?limit=200");
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as ChainsResponse;
      if (!aliveRef.current) return;
      setJobs(normalizeJobs([...(data.in_flight ?? []), ...(data.recent_history ?? [])]));
      setError(null);
      setLoading(false);
      schedule(load, timerRef, POLL_MS);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load specialist chains");
      setLoading(false);
      schedule(load, timerRef, POLL_MS);
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const chains = useMemo(() => groupChains(jobs), [jobs]);
  return { chains, loading, error };
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

function schedule(load: () => Promise<void>, timerRef: MutableRefObject<number | null>, delayMs: number): void {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  timerRef.current = window.setTimeout(() => {
    void load();
  }, delayMs);
}
