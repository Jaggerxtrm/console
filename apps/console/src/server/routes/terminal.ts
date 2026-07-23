import { Hono } from "hono";
import { isLocalhost, isLoopbackAddress, TRUSTED_PEER_ADDRESS_HEADER } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import {
  getShellProviderStatus,
  isAllowedShellWebSocketOrigin,
  isVerifiedShellAdminRequest,
} from "../../../../../packages/core/src/terminal/policy.ts";
import type { TerminalProviderRegistry } from "../../../../../packages/core/src/terminal/provider-registry.ts";
import {
  TERMINAL_TICKET_COOKIE,
  type TerminalTicketRegistry,
} from "../terminal/tickets.ts";

export interface TerminalRouterOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly tickets?: TerminalTicketRegistry;
}

export function createTerminalRouter(providers: TerminalProviderRegistry, options: TerminalRouterOptions = {}): Hono {
  const router = new Hono();
  const env = options.env ?? process.env;
  router.get("/status", (c) => c.json({ providers: providers.list() }));
  router.post("/ticket", (c) => {
    if (!options.tickets) return c.json({ error: "terminal ticket service unavailable" }, 503);

    const host = c.req.header("host") ?? "";
    const peerAddress = c.req.header(TRUSTED_PEER_ADDRESS_HEADER);
    if (peerAddress && isLocalhost(host) && !isLoopbackAddress(peerAddress)) {
      return c.json({ error: "loopback host denied" }, 403);
    }
    if (!isAllowedShellWebSocketOrigin(c.req.header("origin") ?? null, host, env)) {
      return c.json({ error: "shell websocket origin denied" }, 403);
    }

    const isVerifiedAdmin = isVerifiedShellAdminRequest(c.req.raw.headers, env);
    const status = getShellProviderStatus(env, { isVerifiedAdmin });
    if (!status.enabled) return c.json({ error: status.disabledReason }, 403);

    const issued = options.tickets.issue({ isVerifiedAdmin });
    const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
    c.header(
      "Set-Cookie",
      `${TERMINAL_TICKET_COOKIE}=${issued.ticket}; HttpOnly; SameSite=Strict; Path=/api/console/terminal/ws; Max-Age=${Math.ceil(options.tickets.ttlMs / 1000)}${secure}`,
    );
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });
  return router;
}
