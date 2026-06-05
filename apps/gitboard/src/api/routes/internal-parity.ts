import { Hono } from "hono";
import type { ParityHarness } from "../../server/observability/parity.ts";

type InternalParityVariables = { parityHarness: ParityHarness | null };

export function createInternalParityRouter(): Hono<{ Variables: InternalParityVariables }> {
  const app = new Hono<{ Variables: InternalParityVariables }>();

  app.get("/parity/observability", (c) => {
    if (!isLocalhost(c.req.header("host") ?? "")) return c.json({ error: "forbidden" }, 403);
    const harness = c.get("parityHarness") as ParityHarness | undefined;
    const summary = harness?.getLatestSummary() ?? null;
    return c.json({
      parity_ok_count: harness?.getParityOkCount() ?? 0,
      latest_summary: summary,
    });
  });

  return app;
}

function isLocalhost(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}
