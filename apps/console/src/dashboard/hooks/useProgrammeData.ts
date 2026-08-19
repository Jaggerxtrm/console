import { useMemo } from "react";
import type { ProgrammeSnapshotResponse } from "../../types/programme.ts";
import { useDashboardResource, useDashboardResourceInvalidation } from "../lib/resource.ts";

const CACHE_TTL_MS = 60_000;
const STALE_RETRY_DELAY_MS = 750;

export function useProgrammeData() {
  const resource = useDashboardResource<ProgrammeSnapshotResponse>({
    key: "programme",
    cacheTtlMs: CACHE_TTL_MS,
    staleEmptyRetryMs: STALE_RETRY_DELAY_MS,
    isEmpty: (data) => !data.snapshot,
    fetcher: async (resourceKey, options) => {
      void resourceKey;
      const refresh = options.refresh ? "?refresh=true" : "";
      const response = await fetch(`/api/programme${refresh}`);
      if (!response.ok) throw new Error(`Programme fetch failed (${response.status})`);
      return response.json() as Promise<ProgrammeSnapshotResponse>;
    },
  });

  useDashboardResourceInvalidation("substrate:changes", "programme", () => true);

  return { ...resource, reload: resource.refresh };
}

export function useProgrammeGraphData() {
  const { data, ...rest } = useProgrammeData();
  const graph = useMemo(() => data?.snapshot?.graph ?? null, [data]);
  return { ...rest, data: graph, snapshot: data?.snapshot ?? null, freshness: data?.freshness ?? "stale" };
}
