import { Hono } from "hono";
import { createGraphDao } from "../../core/graph-dao.ts";

let defaultDao: ReturnType<typeof createGraphDao> | null = null;

export function createGraphRouter(dao = getDefaultDao()): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projectId = c.req.query("project_id");
    const includeClosed = c.req.query("include_closed") === "true";
    return c.json(await dao.getGraph(projectId, includeClosed));
  });

  return app;
}

function getDefaultDao() {
  if (!defaultDao) defaultDao = createGraphDao();
  return defaultDao;
}
