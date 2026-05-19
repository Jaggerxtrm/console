import { useEffect, useState } from "react";
import type { ChainJob } from "./useChains.ts";

interface ChainDetailResponse {
  chain?: { jobs?: Array<ChainJob & { lastOutput?: string | null; last_output?: string | null }> };
}

export interface UseChainDetailState {
  jobs: ChainJob[];
  loading: boolean;
  error: string | null;
}

export function useChainDetail(chainId: string | null): UseChainDetailState {
  const [jobs, setJobs] = useState<ChainJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (!chainId) {
        setJobs([]);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(`/api/specialists/chains/${encodeURIComponent(chainId)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
        const data = (await res.json()) as ChainDetailResponse;
        if (cancelled) return;
        setJobs((data.chain?.jobs ?? []).map((job) => ({ ...job, lastOutput: job.lastOutput ?? job.last_output ?? null })));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setJobs([]);
        setError(err instanceof Error ? err.message : "Failed to load chain detail");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chainId]);

  return { jobs, loading, error };
}
