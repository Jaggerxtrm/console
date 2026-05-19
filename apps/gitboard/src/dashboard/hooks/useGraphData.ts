import { useEffect, useMemo, useState } from "react";
import type { GraphResponse } from "../pages/console/graph/types.ts";

const CACHE = new Map<string, GraphResponse>();

export function useGraphData(projectId: string | null) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: GraphResponse | null }>({ loading: true, error: null, data: null });

  const key = useMemo(() => projectId ?? "", [projectId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!key || typeof window === "undefined") {
        setState({ loading: false, error: null, data: null });
        return;
      }
      const cached = CACHE.get(key);
      if (cached) setState({ loading: false, error: null, data: cached });
      else setState((curr) => ({ ...curr, loading: true, error: null }));
      try {
        const response = await fetch(`/api/console/graph?project_id=${encodeURIComponent(key)}`);
        if (!response.ok) throw new Error(`Graph fetch failed (${response.status})`);
        const data = (await response.json()) as GraphResponse;
        CACHE.set(key, data);
        if (!cancelled) setState({ loading: false, error: null, data });
      } catch (error) {
        if (cancelled) return;
        setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: null });
      }
    }
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [key]);

  return state;
}
