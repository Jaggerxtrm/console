import { useEffect, useState } from "react";
import type { SpecialistJob } from "../../types/specialists.ts";

interface SpecialistJobsResponse {
  jobs?: Array<SpecialistJob & { lastOutput?: string | null; last_output?: string | null }>;
}

interface CachedHistory {
  jobs: SpecialistHistoryJob[];
  fetchedAt: number;
}

export interface SpecialistHistoryJob extends SpecialistJob {
  lastOutput: string | null;
}

export interface UseSpecialistHistoryState {
  count: number;
  jobs: SpecialistHistoryJob[];
  loading: boolean;
  error: string | null;
}

const CACHE_TTL_MS = 30_000;
const historyCache = new Map<string, CachedHistory>();
const pendingRequests = new Map<string, Promise<SpecialistHistoryJob[]>>();

export function useSpecialistHistory(beadId: string | null): UseSpecialistHistoryState {
  const [state, setState] = useState<UseSpecialistHistoryState>({ count: 0, jobs: [], loading: false, error: null });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!beadId) {
        setState({ count: 0, jobs: [], loading: false, error: null });
        return;
      }

      const cached = historyCache.get(beadId);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        setState({ count: cached.jobs.length, jobs: cached.jobs, loading: false, error: null });
        return;
      }

      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const jobs = await loadJobs(beadId);
        if (!cancelled) setState({ count: jobs.length, jobs, loading: false, error: null });
      } catch (error) {
        if (!cancelled) {
          setState({ count: 0, jobs: [], loading: false, error: error instanceof Error ? error.message : "Failed to load specialist history" });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [beadId]);

  return state;
}

async function loadJobs(beadId: string): Promise<SpecialistHistoryJob[]> {
  const cached = historyCache.get(beadId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.jobs;

  const pending = pendingRequests.get(beadId);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch(`/api/specialists/jobs?bead_id=${encodeURIComponent(beadId)}&include_history=1`);
    if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as SpecialistJobsResponse;
    const jobs = (data.jobs ?? []).map(normalizeJob);
    historyCache.set(beadId, { jobs, fetchedAt: Date.now() });
    return jobs;
  })();

  pendingRequests.set(beadId, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(beadId);
  }
}

function normalizeJob(job: SpecialistJob & { lastOutput?: string | null; last_output?: string | null }): SpecialistHistoryJob {
  return {
    ...job,
    lastOutput: job.lastOutput ?? job.last_output ?? null,
  };
}
