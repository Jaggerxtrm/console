import { useMemo } from "react";
import type { GraphResponse } from "../../types/graph.ts";
import type { WsMessage } from "../lib/ws.ts";
import { useDashboardResource, useDashboardResourceInvalidation } from "../lib/resource.ts";

const CACHE_TTL_MS = 60_000;
const STALE_RETRY_DELAY_MS = 750;
const GRAPH_QUERY_MODE = "include_closed=true";

export function useGraphData(projectId: string | null) {
  const key = useMemo(() => projectId ? `graph:${projectId}` : null, [projectId]);
  const resource = useDashboardResource<GraphResponse>({
    key,
    cacheTtlMs: CACHE_TTL_MS,
    staleEmptyRetryMs: STALE_RETRY_DELAY_MS,
    isEmpty: (data) => data.nodes.length === 0 && (data.freshness ?? "stale") === "stale",
    fetcher: async (resourceKey, options) => {
      const projectKey = resourceKey.replace(/^graph:/, "");
      const refresh = options.refresh ? "&refresh=true" : "";
      const response = await fetch(`/api/console/graph?project_id=${encodeURIComponent(projectKey)}&${GRAPH_QUERY_MODE}${refresh}`);
      if (!response.ok) throw new Error(`Graph fetch failed (${response.status})`);
      return response.json() as Promise<GraphResponse>;
    },
  });

  useDashboardResourceInvalidation("substrate:changes", key, (msg: WsMessage) => {
    const data = msg.data as { projectId?: string; project_id?: string } | undefined;
    const eventProject = data?.projectId ?? data?.project_id;
    return eventProject === projectId;
  });

  return { ...resource, reload: resource.refresh };
}
