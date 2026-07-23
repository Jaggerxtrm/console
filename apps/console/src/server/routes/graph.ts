import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { isAllowedMutationRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { canRefreshSources, createSourceRefreshState } from "../../../../../packages/core/src/runtime/source-lifecycle-policy.ts";
import { makeSourceHealth, type SourceHealth } from "../../../../../packages/core/src/state/source-health.ts";
import { readXtrmGraphSnapshot, type GraphResponse, type GraphSnapshotResult } from "../../../../../packages/core/src/state/read-models/graph.ts";

export interface GraphRouteDao {
  readonly requiresProtectedRefresh: boolean;
  getGraphSnapshotWarm(projectId: string | null | undefined, includeClosed?: boolean): Promise<GraphSnapshotResult>;
  invalidate?(projectId?: string | null): void | Promise<void>;
}

export function createGraphRouter(dao: GraphRouteDao): Hono {
const app = new Hono();
  const refreshStateByProject = new Map<string, ReturnType<typeof createSourceRefreshState>>();
  const maxRefreshKeys = 256;

  app.get("/", async (c) => {
    const projectId = c.req.query("project") ?? c.req.query("project_id");
    const includeClosed = c.req.query("include_closed") === "true";
    if (c.req.query("refresh") === "true" && !dao.requiresProtectedRefresh) await dao.invalidate?.(projectId);
    const { graph, freshness, sourceHealth } = await dao.getGraphSnapshotWarm(projectId, includeClosed);
    return c.json({ ...graph, freshness, source_health: sourceHealth ?? makeGraphSourceHealth(graph, freshness) });
  });

  app.post("/invalidate", async (c) => {
    if (!isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-console-write-token") ?? c.req.header("x-gitboard-sources-admin-token") ?? null, c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!dao.invalidate) return c.json({ error: "graph invalidation unavailable" }, 503);
    const body = await c.req.json().catch(() => null) as { project_id?: unknown } | null;
    const projectId = body?.project_id;
    if (!body || typeof body !== "object" || !isValidProjectId(projectId)) return c.json({ error: "invalid project_id" }, 400);
    const key = projectId ?? "__all__";
    if (!refreshStateByProject.has(key) && refreshStateByProject.size >= maxRefreshKeys) {
      const settledKey = [...refreshStateByProject].find(([, value]) => value.inFlight == null)?.[0];
      if (settledKey) refreshStateByProject.delete(settledKey);
      else return c.json({ error: "graph invalidation busy" }, 429);
    }
    const state = refreshStateByProject.get(key) ?? createSourceRefreshState();
    refreshStateByProject.set(key, state);
    const allowed = canRefreshSources(Date.now(), state);
    if (!allowed.ok) return c.json(allowed.body, allowed.status);
    state.inFlight = Promise.resolve().then(() => dao.invalidate!(projectId)).finally(() => {
      state.inFlight = null;
      state.lastCompletedAt = Date.now();
    });
    await state.inFlight;
    return c.json({ ok: true });
  });

  return app;
}

export function createXtrmGraphRoute(xtrmDb: Database, triggerMaterialization?: (projectId?: string | null) => void): GraphRouteDao {
  return {
    requiresProtectedRefresh: true,
    getGraphSnapshotWarm: async (projectId, includeClosed = false) => readXtrmGraphSnapshot(xtrmDb, projectId, includeClosed),
    ...(triggerMaterialization ? { invalidate: (projectId?: string | null) => triggerMaterialization(projectId) } : {}),
  };
}

function isValidProjectId(value: unknown): value is string | null | undefined {
  return value == null || (typeof value === "string" && value.length <= 256 && /^(?!-)[^\s/\\\x00-\x1F\x7F]+$/.test(value));
}

function makeGraphSourceHealth(graph: GraphResponse & { project?: string }, freshness: "fresh" | "stale" | "degraded"): SourceHealth {
  const note = graph.project;
  if (freshness === "degraded" && note) {
    return makeSourceHealth("graph", "degraded", {
      message: graph.project_id ? `Graph project "${graph.project_id}" was not found.` : "Graph project_id is missing; select a beads project.",
      metadata: { project: note },
    });
  }

  return makeSourceHealth("graph", freshness);
}
