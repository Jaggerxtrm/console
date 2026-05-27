import { Hono } from "hono";
import { createGraphDao } from "../../core/graph-dao.ts";
import { makeSourceHealth, type SourceHealth } from "../../types/source-health.ts";
import type { GraphResponse } from "../../types/graph.ts";
import { canRefreshSources, createSourceRefreshState, isAllowedMutationRequest } from "./sources-policy.ts";

let defaultDao: ReturnType<typeof createGraphDao> | null = null;
const refreshStateByProject = new Map<string, ReturnType<typeof createSourceRefreshState>>();

export function createGraphRouter(dao = getDefaultDao()): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projectId = c.req.query("project") ?? c.req.query("project_id");
    const includeClosed = c.req.query("include_closed") === "true";
    if (c.req.query("refresh") === "true" && !dao.requiresProtectedRefresh) dao.invalidate(projectId);
    const { graph, freshness, sourceHealth } = await dao.getGraphSnapshotWarm(projectId, includeClosed);
    return c.json({ ...graph, freshness, source_health: sourceHealth ?? makeGraphSourceHealth(graph, freshness) });
  });

  app.post("/invalidate", async (c) => {
    if (!isAllowedMutationRequest(c.req.url, c.req.header("host") ?? "", c.req.header("origin") ?? null, c.req.header("x-gitboard-sources-admin-token") ?? null)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const body = await c.req.json().catch(() => ({})) as { project_id?: string | null };
    const key = body.project_id ?? "__all__";
    const state = refreshStateByProject.get(key) ?? createSourceRefreshState();
    refreshStateByProject.set(key, state);
    const allowed = canRefreshSources(Date.now(), state);
    if (!allowed.ok) return c.json(allowed.body, allowed.status);
    state.inFlight = Promise.resolve().then(() => dao.invalidate(body.project_id)).finally(() => {
      state.inFlight = null;
      state.lastCompletedAt = Date.now();
    });
    await state.inFlight;
    return c.json({ ok: true });
  });

  return app;
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

function getDefaultDao() {
  if (!defaultDao) defaultDao = createGraphDao();
  return defaultDao;
}
