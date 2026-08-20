// Client hook for Programme change/revision APIs.
// "Last visit" is browser-local and anchored to one exact programme SHA per
// page lifetime. Time windows and explicit SHA comparisons are server-side;
// multiple consumers (Programme + drawer) share the same baseline.

import { useEffect, useState } from "react";
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
let pageBaseline: string | null | undefined;
let pageCurrent: string | null | undefined;
let sharedLastVisitPromise: Promise<ProgrammeChangeSet> | null = null;

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
  const response = await fetch(url);
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: unknown };
      detail = body.error ? `: ${String(body.error)}` : "";
    } catch {
      // ignore non-JSON error body
    }
    throw new Error(`programme history fetch failed (${response.status})${detail}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchProgrammeCompare(request: ProgrammeCompareRequest): Promise<ProgrammeChangeSet> {
  const params = new URLSearchParams();
  if (request.window) params.set("window", request.window);
  if (request.from) params.set("from", request.from);
  if (request.to) params.set("to", request.to);
  return json<ProgrammeChangeSet>(`/api/programme/compare?${params.toString()}`);
}

function readBaseline(): string | null {
  if (pageBaseline !== undefined) return pageBaseline;
  try {
    pageBaseline = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_VISIT_KEY) : null;
  } catch {
    pageBaseline = null;
  }
  return pageBaseline;
}

async function loadSharedLastVisit(): Promise<ProgrammeChangeSet> {
  if (sharedLastVisitPromise) return sharedLastVisitPromise;
  sharedLastVisitPromise = (async () => {
    const root = await json<ProgrammeSnapshotResponse>("/api/programme");
    const currentSha = root.snapshot?.programme.sha ?? null;
    const baseline = readBaseline();
    pageCurrent = currentSha;

    let changeSet: ProgrammeChangeSet;
    if (!currentSha) changeSet = emptySet(null, baseline);
    else if (!baseline) changeSet = emptySet(currentSha, null);
    else if (baseline === currentSha) changeSet = emptySet(currentSha, baseline);
    else changeSet = await fetchProgrammeCompare({ from: baseline, to: currentSha });

    if (currentSha) {
      try { localStorage.setItem(LAST_VISIT_KEY, currentSha); } catch { /* browser storage unavailable */ }
    }
    useProgrammeChangeStore.getState().setChangeSet(changeSet);
    return changeSet;
  })().catch((error) => {
    sharedLastVisitPromise = null;
    throw error;
  });
  return sharedLastVisitPromise;
}

export function useProgrammeChanges(): ChangeApiState {
  const [changeSet, setChangeSet] = useState<ProgrammeChangeSet | null>(() => useProgrammeChangeStore.getState().changeSet);
  const [loading, setLoading] = useState(!changeSet);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadSharedLastVisit()
      .then((next) => {
        if (cancelled) return;
        setChangeSet(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setChangeSet(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);

  const reload = () => {
    // Re-resolve the current snapshot but keep the page baseline fixed: a
    // refresh in one consumer must not redefine "last visit" for another.
    sharedLastVisitPromise = null;
    pageCurrent = undefined;
    setTick((value) => value + 1);
  };

  return { changeSet, loading, error, reload };
}

/** Fetch FILE-level revision history (best-effort; never labelled entity history). */
export async function fetchRevisionHistory(path: string, entityKey?: string): Promise<ProgrammeRevisionHistory | null> {
  try {
    const params = new URLSearchParams({ path });
    if (entityKey) params.set("entity", entityKey);
    const response = await fetch(`/api/programme/revisions?${params.toString()}`);
    if (!response.ok) return null;
    return await response.json() as ProgrammeRevisionHistory;
  } catch {
    return null;
  }
}

/** Test-only reset for deterministic browser-baseline specs. */
export function resetProgrammeLastVisitForTests(): void {
  pageBaseline = undefined;
  pageCurrent = undefined;
  sharedLastVisitPromise = null;
  useProgrammeChangeStore.getState().setChangeSet(null);
}
