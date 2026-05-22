import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphResponse } from "../../types/graph.ts";
import type { WsMessage } from "../lib/ws.ts";
import { useWebSocket } from "./useWebSocket.ts";

const CACHE_TTL_MS = 10_000;
const STALE_RETRY_DELAY_MS = 750;
const CACHE = new Map<string, { data: GraphResponse; expires: number }>();

export function useGraphData(projectId: string | null) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: GraphResponse | null }>({ loading: true, error: null, data: null });
  const requestSeq = useRef(0);
  const staleRetryTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const staleRetryKey = useRef<string | null>(null);
  const staleRetryUsed = useRef(false);
  const loadRef = useRef<((options?: { refresh?: boolean; force?: boolean }) => Promise<void>) | null>(null);

  const key = useMemo(() => projectId ?? "", [projectId]);

  const clearStaleRetry = useCallback(() => {
    if (staleRetryTimer.current !== null) {
      window.clearTimeout(staleRetryTimer.current);
      staleRetryTimer.current = null;
    }
  }, []);

  const scheduleStaleRetry = useCallback(() => {
    if (staleRetryUsed.current || staleRetryTimer.current !== null || !key || !loadRef.current) return;
    staleRetryUsed.current = true;
    staleRetryKey.current = key;
    staleRetryTimer.current = window.setTimeout(() => {
      staleRetryTimer.current = null;
      void loadRef.current?.({ refresh: true, force: true });
    }, STALE_RETRY_DELAY_MS);
  }, [key]);

  const load = useCallback(async (options: { refresh?: boolean; force?: boolean } = {}) => {
    if (!key || typeof window === "undefined") {
      setState({ loading: false, error: null, data: null });
      return;
    }

    if (staleRetryKey.current !== key) {
      staleRetryKey.current = key;
      staleRetryUsed.current = false;
      clearStaleRetry();
    }

    const cached = CACHE.get(key);
    const fresh = cached && cached.expires > Date.now();
    if (cached) setState({ loading: false, error: null, data: cached.data });
    if (fresh && !options.force && !options.refresh) return;
    if (!cached) setState((curr) => ({ ...curr, loading: true, error: null }));

    const seq = ++requestSeq.current;
    const markBase = `graph:${key}:${seq}`;
    performance.mark(`${markBase}:fetch_start`);
    try {
      const refresh = options.refresh ? "&refresh=true" : "";
      const response = await fetch(`/api/console/graph?project_id=${encodeURIComponent(key)}${refresh}`);
      performance.mark(`${markBase}:fetch_end`);
      if (!response.ok) throw new Error(`Graph fetch failed (${response.status})`);
      const data = (await response.json()) as GraphResponse;
      performance.mark(`${markBase}:paint_ready`);
      performance.measure(`${markBase}:fetch`, `${markBase}:fetch_start`, `${markBase}:fetch_end`);
      CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
      if (seq === requestSeq.current) {
        setState({ loading: false, error: null, data });
        const isEmpty = data.nodes.length === 0;
        const freshness = data.freshness ?? "stale";
        if (isEmpty && freshness === "stale") scheduleStaleRetry();
        else {
          staleRetryUsed.current = false;
          clearStaleRetry();
        }
      }
    } catch (error) {
      performance.mark(`${markBase}:fetch_end`);
      if (seq === requestSeq.current) setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: cached?.data ?? null });
    }
  }, [clearStaleRetry, key, scheduleStaleRetry]);

  loadRef.current = load;

  useEffect(() => () => clearStaleRetry(), [clearStaleRetry]);

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
    staleRetryUsed.current = false;
    clearStaleRetry();
    void loadRef.current?.({ refresh: true, force: true });
  });

  // Specialist overlay changes (job state, in-flight set) are now push-driven via
  // the observability epoch.bump → registry.publish("specialists:activity") wiring
  // in api/server.ts (forge-7cyq). Phase 1 broadcasts a single hint per repo bump;
  // we refetch regardless of which repo bumped — Phase 2 will introduce per-repo
  // channels and a repoSlug↔projectId mapping for finer filtering.
  useWebSocket("specialists:activity", () => {
    if (!key) return;
    // Phase 1: refetch on any specialist hint regardless of repo_slug. Phase 2
    // introduces per-repo channels (specialists:repo:<slug>) + repoSlug↔projectId
    // mapping so a typed SpecialistsSyncHint payload becomes useful for filtering.
    CACHE.delete(key);
    staleRetryUsed.current = false;
    clearStaleRetry();
    void loadRef.current?.({ refresh: true, force: true });
  });

  return { ...state, reload: load };
}
