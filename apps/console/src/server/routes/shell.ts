import { Hono } from "hono";
import { getShellProviderStatus, shellProviderDisabledMessage } from "../../../../../packages/core/src/terminal/policy.ts";

export function createShellRouter(env: NodeJS.ProcessEnv = process.env): Hono {
  const router = new Hono();
  router.get("/status", (c) => {
    const status = getShellProviderStatus(env);
    return c.json({
      enabled: status.enabled,
      disabledReason: status.disabledReason,
      message: shellProviderDisabledMessage(status),
      policy: status.policy,
    });
  });
  router.get("/ws", (c) => {
    const status = getShellProviderStatus(env);
    return status.enabled
      ? c.json({ error: "shell provider not implemented" }, 501)
      : c.json({ error: status.disabledReason }, 403);
  });
  return router;
}
