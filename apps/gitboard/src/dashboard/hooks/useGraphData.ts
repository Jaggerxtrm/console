import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphResponse } from "../../types/graph.ts";
import type { WsMessage } from "../lib/ws.ts";
import { useWebSocket } from "./useWebSocket.ts";

const CACHE_TTL_MS = 10_000;
const CACHE = new Map<string, { data: GraphResponse; expires: number }>();

export function useGraphData(projectId: string | null) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: GraphResponse | null }>({ loading: true, error: null, data: null });
  const requestSeq = useRef(0);

  const key = useMemo(() => projectId ?? "", [projectId]);

  const load = useCallback(async (options: { refresh?: boolean; force?: boolean } = {}) => {
    if (!key || typeof window === "undefined") {
      setState({ loading: false, error: null, data: null });
      return;
    }

    const cached = CACHE.get(key);
    const fresh = cached && cached.expires > Date.now();
    if (cached) setState({ loading: false, error: null, data: cached.data });
    if (fresh && !options.force && !options.refresh) return;
    if (!cached) setState((curr) => ({ ...curr, loading: true, error: null }));

    const seq = ++requestSeq.current;
    try {
      const refresh = options.refresh ? "&refresh=true" : "";
      const response = await fetch(`/api/console/graph?project_id=${encodeURIComponent(key)}${refresh}`);
      if (!response.ok) throw new Error(`Graph fetch failed (${response.status})`);
      const data = (await response.json()) as GraphResponse;
      CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
      if (seq === requestSeq.current) setState({ loading: false, error: null, data });
    } catch (error) {
      if (seq === requestSeq.current) setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: cached?.data ?? null });
    }
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    void load().then(() => { if (cancelled) return; });
    const onFocus = () => { void load(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  useWebSocket("beads:changes", (msg: WsMessage) => {
    const data = msg.data as { projectId?: string; project_id?: string } | undefined;
    const eventProject = data?.projectId ?? data?.project_id;
    if (eventProject && eventProject !== key) return;
    CACHE.delete(key);
    void load({ refresh: true, force: true });
  });

  return state;
}
