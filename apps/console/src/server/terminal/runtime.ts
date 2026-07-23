import { fileURLToPath } from "node:url";
import { isLocalhost, isLoopbackAddress } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import {
  getShellProviderStatus,
  isAllowedShellWebSocketOrigin,
  isShellWebSocketPath,
  isVerifiedShellAdminRequest,
  shouldRejectShellWebSocket,
} from "../../../../../packages/core/src/terminal/policy.ts";
import {
  createTerminalProviderRegistry,
  type TerminalProviderRegistry,
} from "../../../../../packages/core/src/terminal/provider-registry.ts";
import type { HostLogger } from "../log.ts";
import type { ConsoleWebSocketData } from "../ws/realtime.ts";
import { TerminalBridge, type TerminalBridgeEvent } from "./bridge.ts";
import { createTerminalTicketRegistry, type TerminalTicketRegistry } from "./tickets.ts";

export interface ConsoleTerminalOptions {
  readonly logger: HostLogger;
  readonly env?: NodeJS.ProcessEnv;
  readonly providers?: TerminalProviderRegistry;
  readonly tickets?: TerminalTicketRegistry;
}

export function createConsoleTerminal(options: ConsoleTerminalOptions) {
  const env = options.env ?? process.env;
  const providers = options.providers ?? createTerminalProviderRegistry(env, {
    ptyHelperPath: fileURLToPath(new URL("./node-pty-helper.cjs", import.meta.url)),
  });
  const tickets = options.tickets ?? createTerminalTicketRegistry();
  const bridge = new TerminalBridge(providers, {
    onEvent: (event) => emitTerminalEvent(options.logger, event),
  });

  function handleUpgrade(
    request: Request,
    server: Pick<Bun.Server<ConsoleWebSocketData>, "upgrade">,
    peerAddress?: string,
  ): Response | undefined {
    const path = new URL(request.url).pathname;
    const host = request.headers.get("host");
    if (!isShellWebSocketPath(path)) return jsonError("terminal websocket path denied", 404);
    if (peerAddress && isLocalhost(host ?? "") && !isLoopbackAddress(peerAddress)) {
      emitDeny(options.logger, "loopback_host");
      return jsonError("loopback host denied", 403);
    }
    if (!isAllowedShellWebSocketOrigin(request.headers.get("origin"), host, env)) {
      emitDeny(options.logger, "origin");
      return jsonError("shell websocket origin denied", 403);
    }

    const directAdmin = isVerifiedShellAdminRequest(request.headers, env);
    const ticketContext = tickets.consume(request.headers.get("cookie"));
    const isVerifiedAdmin = directAdmin || ticketContext?.isVerifiedAdmin === true;
    const status = getShellProviderStatus(env, { isVerifiedAdmin });
    if (shouldRejectShellWebSocket(path, status)) {
      emitDeny(options.logger, isVerifiedAdmin ? "policy" : "admin");
      return jsonError(status.disabledReason, 403);
    }
    return bridge.handleUpgrade(request, server, path, { isVerifiedAdmin });
  }

  const websocket: Bun.WebSocketHandler<ConsoleWebSocketData> = {
    open(ws) {
      const pendingId = ws.data?.connId;
      const id = bridge.connect((data) => ws.send(data), pendingId);
      (ws as typeof ws & { connId: string }).connId = id;
    },
    message(ws, message) {
      const id = (ws as typeof ws & { connId?: string }).connId;
      if (id) void bridge.handleMessage(id, message.toString());
    },
    close(ws) {
      const id = (ws as typeof ws & { connId?: string }).connId;
      if (id) bridge.disconnect(id);
    },
  };

  return {
    providers,
    tickets,
    bridge,
    handleUpgrade,
    websocket,
    stop: () => bridge.stop(),
  };
}

function emitTerminalEvent(logger: HostLogger, event: TerminalBridgeEvent): void {
  const { event: name, outcome, ...data } = event;
  const level = outcome === "error" ? "error" : outcome === "denied" ? "warn" : "info";
  logger.emit(makeLogEntry("terminal", name, level, undefined, { outcome, ...data }));
}

function emitDeny(logger: HostLogger, code: string): void {
  logger.emit(makeLogEntry("terminal", "upgrade.denied", "warn", undefined, { outcome: "denied", code }));
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
