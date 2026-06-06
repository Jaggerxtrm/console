import { Hono } from "hono";

// This endpoint returns minimal liveness; per-project source health lives on
// /api/substrate/projects.
export function createInternalDoltHealthRouter(): Hono {
  const app = new Hono();

  app.get("/dolt-health", (c) => {
    const host = c.req.header("host") ?? "";
    if (!host.startsWith("localhost") && !host.startsWith("127.0.0.1") && !host.startsWith("[::1]")) {
      return c.json({ error: "forbidden" }, 403);
    }

    return c.json({
      state: "ok",
      note: "See /api/substrate/projects for per-project source health.",
    });
  });

  return app;
}
