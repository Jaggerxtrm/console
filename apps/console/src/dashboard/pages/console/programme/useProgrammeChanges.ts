// Client hook for Programme change/revision APIs.
// "Last visit" is browser-local and anchored to an exact programme SHA. Time
// windows and explicit SHA comparisons are delegated to /api/programme/compare;
// the UI never simulates them by filtering a two-snapshot diff.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { ProgrammeChangeSet, ProgrammeRevisionHistory, ProgrammeSnapshotResponse } from "../../../../types/programme.ts";

export type ProgrammeCompareWindow = "24h" | "7d" | "30d";
export type ProgrammeCompareRequest = { window?: ProgrammeCompareWindow; from?: string; to?: string };

interface ChangeApiState {
  changeSet: ProgrammeChangeSet | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

interface ProgrammeChangeStoreState {
  changeSet: ProgrammeChangeSet | null;
  setChangeSet: (changeSet: ProgrammeChangeSet | null) => void;
}

export const useProgrammeChangeStore = create<ProgrammeChangeStoreState>((set) => ({
  changeSet: null,
  setChangeSet: (changeSet) => set({ changeSet }),
}));

const LAST_VISIT_KEY = "programme:last-visit-sha:v1";

function emptySet(currentSha: string | null, previousSha: string | null = null): ProgrammeChangeSet {
  return {
    previous_sha: previousSha,
    current_sha: currentSha,
    generated_at: new Date().toISOString(),
    entities: [],
    relation_count: 0,
  };
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json() as { error?: unknown };
      detail = body.error ? `: ${String(body.error)}` : "";
    } catch {
      // ignore non-JSON error body
    }
    throw new Error(`programme history fetch failed (${res.status})${detail}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchProgrammeCompare(request: ProgrammeCompareRequest): Promise<ProgrammeChangeSet> {
  const params = new URLSearchParams();
  if (request.window) params.set("window", request.window);
  if (request.from) params.set("from", request.from);
  if (request.to) params.set("to", request.to);
  return json<ProgrammeChangeSet>(`/api/programme/compare?${params.toString()}`);
}

export function useProgrammeChanges(): ChangeApiState {
  const [changeSet, setChangeSet] = useState<ProgrammeChangeSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const baselineRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const root = await json<ProgrammeSnapshotResponse>("/api/programme");
        const currentSha = root.snapshot?.programme.sha ?? null;
        if (baselineRef.current === undefined) {
          try {
            baselineRef.current = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_VISIT_KEY) : null;
          } catch {
            baselineRef.current = null;
          }
        }
        const baseline = baselineRef.current ?? null;
        let next: ProgrammeChangeSet;

        if (!currentSha) {
          next = emptySet(null, baseline);
        } else if (!baseline) {
          // First browser observation: there is no truthful "last visit" baseline.
          next = emptySet(currentSha, null);
        } else if (baseline === currentSha) {
          next = emptySet(currentSha, baseline);
        } else {
          next = await fetchProgrammeCompare({ from: baseline, to: currentSha });
        }

        if (cancelled) return;
        setChangeSet(next);
        useProgrammeChangeStore.getState().setChangeSet(next);
        setError(null);
        if (currentSha) {
          try { localStorage.setItem(LAST_VISIT_KEY, currentSha); } catch { /* browser storage unavailable */ }
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setChangeSet(null);
        useProgrammeChangeStore.getState().setChangeSet(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [tick]);

  return { changeSet, loading, error, reload: () => setTick((value) => value + 1) };
}

/** Fetch FILE-level revision history (best-effort; never labelled entity history). */
export async function fetchRevisionHistory(path: string, entityKey?: string): Promise<ProgrammeRevisionHistory | null> {
  try {
    const params = new URLSearchParams({ path });
    if (entityKey) params.set("entity", entityKey);
    const res = await fetch(`/api/programme/revisions?${params.toString()}`);
    if (!res.ok) return null;
    return await res.json() as ProgrammeRevisionHistory;
  } catch {
    return null;
  }
}
