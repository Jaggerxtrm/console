import { Hono } from "hono";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { Verifier, type VerificationResult } from "../../../../../packages/core/src/runtime/verifier.ts";

export type InternalVerifyRouterOptions = {
  emit?: (entry: LogEntry) => void;
  verify?: (since: string, until: string) => Promise<VerificationResult>;
};

const MAX_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function createInternalVerifyRouter(options: InternalVerifyRouterOptions = {}): Hono {
  const app = new Hono();
  let inFlight = false;

  app.get("/verify-runtime", async (c) => {
    if (!isTrustedLocalhostRequest(c.req.url, c.req.header("host") ?? "", c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) return c.json({ error: "forbidden" }, 403);
    const since = c.req.query("since") ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = c.req.query("until") ?? new Date().toISOString();
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs || untilMs - sinceMs > MAX_VERIFY_INTERVAL_MS) {
      return c.json({ error: "invalid verification interval" }, 400);
    }
    if (inFlight) return c.json({ error: "verification already in progress" }, 429);
    const verify = options.verify ?? ((start, end) => new Verifier({
      onMetrics: (metrics) => options.emit?.(makeLogEntry("api", "verify-runtime", "info", undefined, metrics)),
    }).verify(start, end));
    inFlight = true;
    try {
      return c.json(await verify(since, until));
    } finally {
      inFlight = false;
    }
  });

  return app;
}
