import { Hono } from "hono";
import { Verifier } from "../../core/observability/verifier.ts";
import { emit, makeLogEntry } from "../../core/logger.ts";

export function createInternalVerifyRouter(): Hono {
  const app = new Hono();

  app.get("/verify-runtime", async (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    const since = c.req.query("since") ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = c.req.query("until") ?? new Date().toISOString();
    const verifier = new Verifier({
      onMetrics: (metrics) => emit(makeLogEntry("api", "verify-runtime", "info", undefined, metrics)),
    });
    return c.json(await verifier.verify(since, until));
  });

  return app;
}

function isLocalhost(host: string): boolean { return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]"); }
