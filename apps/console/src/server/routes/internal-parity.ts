import { Hono } from "hono";
import { isTrustedLocalhostRequest, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { paritySummaryForTelemetry, type ParitySummary } from "../../../../../packages/core/src/observability/parity.ts";

export interface InternalParityHarness {
  getParityOkCount(): number;
  getLatestSummary(): ParitySummary | null;
}

export type InternalParityHarnessResolver = () => InternalParityHarness | null;

export function createInternalParityRouter(resolveHarness: InternalParityHarnessResolver = () => null): Hono {
  const app = new Hono();
  app.get("/parity/observability", (c) => {
    if (!isTrustedLocalhostRequest(c.req.url, c.req.header("host") ?? "", c.req.header(TRUSTED_PEER_ADDRESS_HEADER))) return c.json({ error: "forbidden" }, 403);
    const harness = resolveHarness();
    const summary = harness?.getLatestSummary() ?? null;
    return c.json({
      parity_ok_count: harness?.getParityOkCount() ?? 0,
      latest_summary: summary ? paritySummaryForTelemetry(summary) : null,
    });
  });

  return app;
}
