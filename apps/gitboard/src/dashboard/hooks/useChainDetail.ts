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

// Match the chain-list poll cadence so the per-chain detail keeps up with new
// turns / status changes from in-flight specialists.
const POLL_MS = 5000;

export function useChainDetail(chainId: string | null): UseChainDetailState {
  const [jobs, setJobs] = useState<ChainJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let controller = new AbortController();

    const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

    async function load(initial: boolean) {
      if (!chainId) {
        if (cancelled) return;
        setJobs([]);
        setLoading(false);
        setError(null);
        return;
      }
      if (!isVisible()) return;
      if (initial) setLoading(true);
      try {
        controller.abort();
        controller = new AbortController();
        const res = await fetch(`/api/specialists/chains/${encodeURIComponent(chainId)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
        const data = (await res.json()) as ChainDetailResponse;
        if (cancelled) return;
        setJobs((data.chain?.jobs ?? []).map((job) => ({ ...job, lastOutput: job.lastOutput ?? job.last_output ?? null })));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load chain detail");
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }

    function schedule() {
      if (cancelled) return;
      timer = window.setTimeout(async () => {
        await load(false);
        schedule();
      }, POLL_MS);
    }

    const onVisibility = () => {
      if (isVisible()) {
        void load(false);
        schedule();
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    void load(true).then(() => { schedule(); });

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [chainId]);

  return { jobs, loading, error };
}
