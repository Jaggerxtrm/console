import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import type { WsMessage } from "./ws.ts";

export type DashboardResourceFreshness = "fresh" | "stale" | "degraded";

export type DashboardResourceState<TData> = {
  data: TData | null;
  loading: boolean;
  error: string | null;
  freshness: DashboardResourceFreshness;
};

export type DashboardResourceOptions<TData> = {
  key: string | null;
  cacheTtlMs: number;
  coalesceMs?: number;
  pollMs?: number;
  staleEmptyRetryMs?: number;
  isEmpty?: (data: TData) => boolean;
  fetcher: (key: string, options: { refresh: boolean; signal: AbortSignal }) => Promise<TData>;
};

type CacheEntry<TData> = {
  data: TData;
  fetchedAt: number;
  expiresAt: number;
  freshness: DashboardResourceFreshness;
};

type Subscriber = () => void;

const cache = new Map<string, CacheEntry<unknown>>();
const subscribers = new Map<string, Set<Subscriber>>();
type BrowserTimer = ReturnType<typeof setTimeout>;

const invalidateTimers = new Map<string, BrowserTimer>();

export function readDashboardResource<TData>(key: string | null): TData | null {
  if (!key) return null;
  return (cache.get(key)?.data as TData | undefined) ?? null;
}

export function invalidateDashboardResource(key: string, coalesceMs = 1500): void {
  if (typeof window === "undefined") return;
  if (invalidateTimers.has(key)) return;
  invalidateTimers.set(key, setTimeout(() => {
    invalidateTimers.delete(key);
    const entry = cache.get(key);
    if (entry) cache.set(key, { ...entry, expiresAt: 0, freshness: "stale" });
    notifySubscribers(key);
  }, coalesceMs));
}

export function applyDashboardResourceDelta<TData>(key: string, updater: (current: TData) => TData | null): TData | null {
  const entry = cache.get(key) as CacheEntry<TData> | undefined;
  if (!entry) return null;
  const next = updater(entry.data);
  if (!next) return null;
  cache.set(key, { ...entry, data: next });
  notifySubscribers(key);
  return next;
}

type RefreshOptions = { force?: boolean; refresh?: boolean };

export function useDashboardResource<TData>(options: DashboardResourceOptions<TData>): DashboardResourceState<TData> & { refresh: (options?: RefreshOptions) => Promise<void> } {
  const { key, cacheTtlMs, pollMs, staleEmptyRetryMs, isEmpty } = options;
  const fetcherRef = useRef(options.fetcher);
  const isEmptyRef = useRef(isEmpty);
  fetcherRef.current = options.fetcher;
  isEmptyRef.current = isEmpty;
  const [state, setState] = useState<DashboardResourceState<TData>>(() => ({ data: readDashboardResource<TData>(key), loading: key !== null && !readDashboardResource<TData>(key), error: null, freshness: readDashboardResourceFreshness(key) }));
  const requestSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimer = useRef<BrowserTimer | null>(null);
  const staleTimer = useRef<BrowserTimer | null>(null);
  const staleRetryUsed = useRef(false);
  const visibleRef = useRef(typeof document === "undefined" ? true : document.visibilityState === "visible");

  const clearTimer = useCallback((timer: BrowserTimer | null) => {
    if (timer !== null) clearTimeout(timer);
  }, []);

  const schedulePoll = useCallback((refresh: (options?: RefreshOptions) => Promise<void>) => {
    clearTimer(pollTimer.current);
    pollTimer.current = null;
    if (!pollMs || !key || !visibleRef.current) return;
    pollTimer.current = setTimeout(() => {
      void refresh({ force: true, refresh: true });
    }, pollMs);
  }, [clearTimer, key, pollMs]);

  const scheduleStaleRetry = useCallback((refresh: (options?: RefreshOptions) => Promise<void>) => {
    if (!staleEmptyRetryMs || staleRetryUsed.current || staleTimer.current !== null) return;
    staleRetryUsed.current = true;
    staleTimer.current = setTimeout(() => {
      staleTimer.current = null;
      void refresh({ force: true });
    }, staleEmptyRetryMs);
  }, [staleEmptyRetryMs]);

  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => {});

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!key || typeof window === "undefined") {
      setState({ data: null, loading: false, error: null, freshness: "stale" });
      return;
    }

    const cached = readDashboardResource<TData>(key);
    if (cached) setState((current) => ({ ...current, data: cached, error: null, loading: false, freshness: readDashboardResourceFreshness(key) }));
    if (cached && !options.force && !options.refresh && isFresh(key)) return;
    if (!cached) setState((current) => ({ ...current, loading: true, error: null }));

    const seq = ++requestSeq.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await fetcherRef.current(key, { refresh: options.refresh ?? false, signal: controller.signal });
      if (seq !== requestSeq.current || controller.signal.aborted) return;
      abortRef.current = null;
      const now = Date.now();
      const freshness = extractFreshness(data);
      cache.set(key, { data, fetchedAt: now, expiresAt: now + cacheTtlMs, freshness });
      setState({ data, loading: false, error: null, freshness });
      schedulePoll(refresh);
      if (isEmptyRef.current?.(data)) scheduleStaleRetry(refresh);
      else {
        staleRetryUsed.current = false;
        clearTimer(staleTimer.current);
        staleTimer.current = null;
      }
    } catch (error) {
      if (seq !== requestSeq.current || controller.signal.aborted) return;
      abortRef.current = null;
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error), data: cached ?? current.data, freshness: cached ? "degraded" : current.freshness }));
      schedulePoll(refresh);
    }
  }, [cacheTtlMs, clearTimer, key, schedulePoll, scheduleStaleRetry]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null, freshness: "stale" });
      return;
    }
    staleRetryUsed.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    const cached = readDashboardResource<TData>(key);
    setState({ data: cached, loading: !cached, error: null, freshness: readDashboardResourceFreshness(key) });
    const subscriber = () => { staleRetryUsed.current = false; void refreshRef.current(); };
    registerSubscriber(key, subscriber);
    void refreshRef.current();
    const onFocus = () => { if (document.visibilityState === "visible") void refreshRef.current(); };
    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) void refreshRef.current();
      else clearTimer(pollTimer.current);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unregisterSubscriber(key, subscriber);
      abortRef.current?.abort();
      abortRef.current = null;
      clearTimer(pollTimer.current);
      clearTimer(staleTimer.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearTimer, key]);

  return { ...state, refresh };
}

function registerSubscriber(key: string, subscriber: Subscriber): void {
  const set = subscribers.get(key) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(key, set);
}

function unregisterSubscriber(key: string, subscriber: Subscriber): void {
  const set = subscribers.get(key);
  if (!set) return;
  set.delete(subscriber);
  if (set.size === 0) subscribers.delete(key);
}

function notifySubscribers(key: string): void {
  for (const subscriber of subscribers.get(key) ?? []) subscriber();
}

function isFresh(key: string): boolean {
  const entry = cache.get(key);
  return !!entry && entry.expiresAt > Date.now();
}


export function readDashboardResourceFreshness(key: string | null): DashboardResourceFreshness {
  if (!key) return "stale";
  return cache.get(key)?.freshness ?? "stale";
}

export function useDashboardResourceInvalidation(
  channel: string,
  key: string | null,
  shouldInvalidate?: (msg: WsMessage) => boolean,
  coalesceMs?: number,
): void {
  useWebSocket(channel, (msg) => {
    if (!key) return;
    if (shouldInvalidate && !shouldInvalidate(msg)) return;
    invalidateDashboardResource(key, coalesceMs);
  });
}

function extractFreshness(data: unknown): DashboardResourceFreshness {
  if (data && typeof data === "object" && "freshness" in data) {
    const freshness = (data as { freshness?: unknown }).freshness;
    if (freshness === "fresh" || freshness === "stale" || freshness === "degraded") return freshness;
  }
  return "fresh";
}
