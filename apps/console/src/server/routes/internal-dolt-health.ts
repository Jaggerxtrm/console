import { Hono } from "hono";
import { isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";

// This endpoint returns minimal liveness; per-project source health lives on
// /api/substrate/projects.
export function createInternalDoltHealthRouter(): Hono {
  const app = new Hono();

  app.get("/dolt-health", (c) => {
    const host = c.req.header("host") ?? "";
    if (!isTrustedLocalhostRequest(c.req.url, host, c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) {
      return c.json({ error: "forbidden" }, 403);
    }

    return c.json({
      state: "ok",
      note: "See /api/substrate/projects for per-project source health.",
    });
  });

  return app;
}
