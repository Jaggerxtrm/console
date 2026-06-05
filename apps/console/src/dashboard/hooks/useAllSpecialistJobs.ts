import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { SpecialistJob } from "../../types/specialists.ts";

interface AllSpecialistJobsResponse {
  in_flight?: SpecialistJob[];
  recent_history?: SpecialistJob[];
  epoch?: Record<string, number>;
}

const POLL_MS = 5000;

export interface UseAllSpecialistJobsState {
  inFlight: SpecialistJob[];
  history: SpecialistJob[];
  loading: boolean;
  error: string | null;
}

export function useAllSpecialistJobs(limit = 50): UseAllSpecialistJobsState {
  const [inFlight, setInFlight] = useState<SpecialistJob[]>([]);
  const [history, setHistory] = useState<SpecialistJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/specialists/jobs/in-flight?limit=${encodeURIComponent(String(limit))}`);
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as AllSpecialistJobsResponse;
      if (!aliveRef.current) return;
      setInFlight(data.in_flight ?? []);
      setHistory(data.recent_history ?? []);
      setError(null);
      setLoading(false);
      schedule(load, timerRef, POLL_MS);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load specialist jobs");
      setLoading(false);
      schedule(load, timerRef, POLL_MS);
    }
  }, [limit]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  return { inFlight, history, loading, error };
}

function schedule(load: () => Promise<void>, timerRef: MutableRefObject<number | null>, delayMs: number): void {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  timerRef.current = window.setTimeout(() => { void load(); }, delayMs);
}
