import { Hono } from "hono";
import { getShellProviderStatus, shellProviderDisabledMessage } from "../../core/shell-provider-policy.ts";

export function createShellRouter() {
  const router = new Hono();

  router.get("/status", (c) => {
    const status = getShellProviderStatus(process.env);
    return c.json({
      enabled: status.enabled,
      disabledReason: status.disabledReason,
      message: shellProviderDisabledMessage(status),
      policy: status.policy,
    });
  });

  router.get("/ws", (c) => {
    const status = getShellProviderStatus(process.env);
    if (!status.enabled) {
      return c.json({ error: status.disabledReason }, 403);
    }
    return c.json({ error: "shell provider not implemented" }, 501);
  });

  return router;
}
