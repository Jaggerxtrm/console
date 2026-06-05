import { Hono } from "hono";

// PR#10 reshaped beadboard's dolt-client (forge-1qz pool snapshot removed in favor of
// per-project ProjectSourceHealth). This endpoint now returns a minimal liveness
// payload until a follow-up reintroduces a pool snapshot if needed.
export function createInternalDoltHealthRouter(): Hono {
  const app = new Hono();

  app.get("/dolt-health", (c) => {
    const host = c.req.header("host") ?? "";
    if (!host.startsWith("localhost") && !host.startsWith("127.0.0.1") && !host.startsWith("[::1]")) {
      return c.json({ error: "forbidden" }, 403);
    }

    return c.json({
      state: "ok",
      note: "Pool snapshot retired in PR#10; see /api/substrate/projects for per-project source health.",
    });
  });

  return app;
}
