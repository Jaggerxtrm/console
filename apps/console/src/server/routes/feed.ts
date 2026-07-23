import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFeedPage, normalizeFeedLimit } from "../../../../../packages/core/src/state/index.ts";

export function createFeedRouter(db?: Database | null): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json(readFeedPage(db, {
      limit: normalizeFeedLimit(c.req.query("limit")),
      cursor: c.req.query("cursor") ?? null,
    }));
  });

  return router;
}
