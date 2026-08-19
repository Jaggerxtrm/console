import { useMemo } from "react";
import type { ProgrammeSnapshotResponse } from "../../types/programme.ts";
import { useDashboardResource } from "../lib/resource.ts";

const CACHE_TTL_MS = 60_000;
const STALE_RETRY_DELAY_MS = 750;
const POLL_MS = 5 * 60_000;

type ReloadOptions = { force?: boolean; refresh?: boolean };

export function useProgrammeData() {
  const resource = useDashboardResource<ProgrammeSnapshotResponse>({
    key: "programme",
    cacheTtlMs: CACHE_TTL_MS,
    pollMs: POLL_MS,
    staleEmptyRetryMs: STALE_RETRY_DELAY_MS,
    isEmpty: (data) => !data.snapshot,
    fetcher: async (resourceKey, options) => {
      void resourceKey;
      const refresh = options.refresh ? "?refresh=true" : "";
      const response = await fetch(`/api/programme${refresh}`, { signal: options.signal });
      if (!response.ok) throw new Error(`Programme fetch failed (${response.status})`);
      return response.json() as Promise<ProgrammeSnapshotResponse>;
    },
  });

  // Programme is Git-backed and does not share the repository-local substrate
  // mutation stream. Reuse the existing dashboard poll/focus primitive instead
  // of pretending `substrate:changes` is a programme invalidation signal.
  const reload = (options: ReloadOptions = {}) => resource.refresh({
    ...options,
    refresh: true,
  });

  return { ...resource, reload };
}

export function useProgrammeGraphData() {
  const { data, ...rest } = useProgrammeData();
  const graph = useMemo(() => data?.snapshot?.graph ?? null, [data]);
  return { ...rest, data: graph, snapshot: data?.snapshot ?? null, freshness: data?.freshness ?? "stale" };
}
