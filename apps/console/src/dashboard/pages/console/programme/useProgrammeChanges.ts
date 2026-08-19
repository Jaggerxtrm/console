// Client hook for the programme changes/revisions API surface.

import { useEffect, useState } from "react";
import type { ProgrammeChangeSet, ProgrammeRevisionHistory } from "../../../../types/programme.ts";

interface ChangeApiState {
  changeSet: ProgrammeChangeSet | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const emptySet = (): ProgrammeChangeSet => ({
  previous_sha: null,
  current_sha: null,
  generated_at: "",
  entities: [],
  relation_count: 0,
});

export function useProgrammeChanges(): ChangeApiState {
  const [changeSet, setChangeSet] = useState<ProgrammeChangeSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/programme/changes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`changes fetch failed (${res.status})`))))
      .then((data) => {
        if (cancelled) return;
        setChangeSet(data as ProgrammeChangeSet);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setChangeSet(emptySet());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tick]);

  return { changeSet, loading, error, reload: () => setTick((t) => t + 1) };
}

/** Fetch per-path revision history (best-effort; graceful on failure). */
export async function fetchRevisionHistory(path: string): Promise<ProgrammeRevisionHistory | null> {
  try {
    const params = new URLSearchParams({ path });
    const res = await fetch(`/api/programme/revisions?${params.toString()}`);
    if (!res.ok) return null;
    return await res.json() as ProgrammeRevisionHistory;
  } catch {
    return null;
  }
}
