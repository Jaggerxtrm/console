import { useEffect, useMemo, useState } from "react";
import type { SpecialistChain } from "../../../server/observability/types.ts";

interface ChainState {
  chain: SpecialistChain[] | null;
  loading: boolean;
}

const enc = encodeURIComponent;

export function useChain(beadId: string | null): ChainState {
  const [chain, setChain] = useState<SpecialistChain[] | null>(null);
  const [loading, setLoading] = useState(false);

  const enabled = useMemo(() => Boolean(beadId), [beadId]);

  useEffect(() => {
    if (!enabled || !beadId) {
      setChain(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let alive = true;

    async function loadChain() {
      setLoading(true);
      try {
        const jobsRes = await fetch(`/api/specialists/jobs?bead_id=${enc(beadId ?? "")}`, { signal: controller.signal });
        if (!jobsRes.ok) {
          if (alive) setChain(null);
          return;
        }
        const jobsData = await jobsRes.json() as { jobs?: Array<{ chainId?: string | null; chain_id?: string | null }> };
        const chainId = jobsData.jobs?.find((job) => job.chainId || job.chain_id)?.chainId ?? jobsData.jobs?.find((job) => job.chainId || job.chain_id)?.chain_id ?? null;
        const chainIdParam = chainId ?? "";
        if (!chainIdParam) {
          if (alive) setChain(null);
          return;
        }

        const chainRes = await fetch(`/api/specialists/chains/${enc(chainIdParam)}`, { signal: controller.signal });
        if (!chainRes.ok) {
          if (alive) setChain(null);
          return;
        }
        const data = await chainRes.json() as { chain?: { jobs?: SpecialistChain[] } };
        if (alive) setChain(data.chain?.jobs ?? null);
      } catch {
        if (alive) setChain(null);
      } finally {
        if (alive) setLoading(false);
      }
    }

    void loadChain();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [beadId, enabled]);

  return { chain, loading };
}
