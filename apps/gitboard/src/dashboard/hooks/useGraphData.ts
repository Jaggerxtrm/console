import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphResponse } from "../../types/graph.ts";
import type { WsMessage } from "../lib/ws.ts";
import { useWebSocket } from "./useWebSocket.ts";

const CACHE_TTL_MS = 10_000;
const STALE_RETRY_DELAY_MS = 750;
const REFETCH_COALESCE_MS = 1_500; // forge-h830: collapse WS-driven refetch bursts
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

  // forge-h830: coalesce refetch on burst events. Without this, a watcher
  // storm (50+ events/sec) caused the UI to thrash — invalidate, refetch,
  // loading, repeat. The trailing setTimeout collapses any burst arriving
  // within REFETCH_COALESCE_MS into a single refetch.
  const refetchTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (!key) return;
    if (refetchTimer.current !== null) return; // already scheduled
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      CACHE.delete(key);
      staleRetryUsed.current = false;
      clearStaleRetry();
      void loadRef.current?.({ refresh: true, force: true });
    }, REFETCH_COALESCE_MS);
  }, [key, clearStaleRetry]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
  }, []);

  useWebSocket("beads:changes", (msg: WsMessage) => {
    const data = msg.data as { projectId?: string; project_id?: string } | undefined;
    const eventProject = data?.projectId ?? data?.project_id;
    if (eventProject && eventProject !== key) return;
    scheduleRefetch();
  });

  // Specialist overlay changes via observability epoch.bump → registry.publish
  // ("specialists:activity") wiring in api/server.ts (forge-7cyq). Phase 2 will
  // introduce per-repo channels for finer filtering; for now any hint refetches.
  useWebSocket("specialists:activity", () => {
    scheduleRefetch();
  });

  return { ...state, reload: load };
}
