import { useMemo } from "react";
import type { ProgrammeSnapshotResponse } from "../../types/programme.ts";
import { useDashboardResource } from "../lib/resource.ts";
import { useProgrammeChangeStore } from "../pages/console/programme/useProgrammeChanges.ts";

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
  const lastVisit = useProgrammeChangeStore((state) => state.changeSet);

  // The API's cheap changes_summary is process-observation evidence. List/card
  // Δ chips are explicitly "last visit", so only expose a summary derived from
  // the browser's exact last-visit compare and only when it targets this exact
  // snapshot SHA. Never silently substitute a different baseline.
  const data = useMemo<ProgrammeSnapshotResponse | null>(() => {
    if (!resource.data) return null;
    const currentSha = resource.data.snapshot?.programme.sha ?? null;
    if (!lastVisit || !currentSha || lastVisit.current_sha !== currentSha) {
      return { ...resource.data, changes_summary: null };
    }
    return {
      ...resource.data,
      changes_summary: {
        previous_sha: lastVisit.previous_sha,
        current_sha: lastVisit.current_sha,
        changed_entities: lastVisit.entities.length,
        changed_entity_keys: lastVisit.entities.map((entity) => entity.entity_key),
        changed_relations: lastVisit.relation_count,
      },
    };
  }, [resource.data, lastVisit]);

  // Programme is Git-backed and does not share the repository-local substrate
  // mutation stream. Reuse the existing dashboard poll/focus primitive instead
  // of pretending `substrate:changes` is a programme invalidation signal.
  const reload = (options: ReloadOptions = {}) => resource.refresh({
    ...options,
    refresh: true,
  });

  return { ...resource, data, reload };
}

export function useProgrammeGraphData() {
  const { data, ...rest } = useProgrammeData();
  const graph = useMemo(() => data?.snapshot?.graph ?? null, [data]);
  return { ...rest, data: graph, snapshot: data?.snapshot ?? null, freshness: data?.freshness ?? "stale" };
}
