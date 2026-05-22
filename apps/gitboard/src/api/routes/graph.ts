import { Hono } from "hono";
import { createGraphDao } from "../../core/graph-dao.ts";
import { makeSourceHealth } from "../../types/source-health.ts";

let defaultDao: ReturnType<typeof createGraphDao> | null = null;

export function createGraphRouter(dao = getDefaultDao()): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projectId = c.req.query("project") ?? c.req.query("project_id");
    const includeClosed = c.req.query("include_closed") === "true";
    if (c.req.query("refresh") === "true") dao.invalidate(projectId);
    const { graph, freshness } = await dao.getGraphSnapshotWarm(projectId, includeClosed);
    return c.json({ ...graph, freshness, source_health: makeSourceHealth("graph", freshness) });
  });

  app.post("/invalidate", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { project_id?: string | null };
    dao.invalidate(body.project_id);
    return c.json({ ok: true });
  });

  return app;
}

function getDefaultDao() {
  if (!defaultDao) defaultDao = createGraphDao();
  return defaultDao;
}
