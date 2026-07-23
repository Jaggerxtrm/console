import { isLocalhost, isLoopbackAddress } from "../../../../../packages/core/src/runtime/console-write-policy.ts";
import {
  REALTIME_PROTOCOL_VERSION,
  RealtimeChannelRegistry,
  RealtimeConnectionHandler,
} from "../../../../../packages/core/src/runtime/realtime.ts";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import type { HostLogger } from "../log.ts";

export type ConsoleWebSocketData = {
  path?: string;
};

export interface ConsoleRealtimeOptions {
  readonly logger: HostLogger;
}

export function createConsoleRealtime(options: ConsoleRealtimeOptions) {
  const registry = new RealtimeChannelRegistry();
  const handler = new RealtimeConnectionHandler(registry, {
    onConnect: (id) => options.logger.emit(makeLogEntry("ws", "client.connected", "info", undefined, { id })),
    onDisconnect: (id) => options.logger.emit(makeLogEntry("ws", "client.disconnected", "info", undefined, { id })),
    onVersionMismatch: ({ id, channel }) => {
      options.logger.emit(makeLogEntry("ws", "subscribe.version_mismatch", "warn", undefined, {
        id,
        channel,
        version: "[INVALID]",
      }));
    },
    onBackpressure: ({ id, channel, bytes, status }) => {
      options.logger.emit(makeLogEntry("ws", `ws.publish.${status}`, "warn", undefined, { id, channel, bytes, status }));
    },
  });

  options.logger.setRealtimePublisher((entry) => {
    registry.publish("system", "system:log", entry, entry.ts);
  });

  function handleUpgrade(
    request: Request,
    server: Pick<Bun.Server<ConsoleWebSocketData>, "upgrade">,
    peerAddress?: string,
  ): Response | undefined {
    const host = request.headers.get("host");
    if (peerAddress && isLocalhost(host ?? "") && !isLoopbackAddress(peerAddress)) {
      return jsonError("loopback host denied", 403);
    }
    if (!isAllowedRealtimeWebSocketOrigin(
      request.url,
      request.headers.get("origin"),
      host,
      request.headers.get("x-gitboard-ws-token"),
      process.env,
    )) {
      return jsonError("websocket origin denied", 403);
    }

    const path = new URL(request.url).pathname;
    const upgraded = server.upgrade(request, { data: { path } });
    return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
  }

  const websocket: Bun.WebSocketHandler<ConsoleWebSocketData> = {
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(ws) {
      const id = handler.connect({
        send: (data) => ws.send(data),
        close: (code) => ws.close(code),
      });
      (ws as typeof ws & { connId: string }).connId = id;
      ws.send(JSON.stringify({ type: "connected", id }));
    },
    message(ws, message) {
      const id = (ws as typeof ws & { connId?: string }).connId;
      if (id) handler.handleMessage(id, message.toString());
    },
    close(ws) {
      const id = (ws as typeof ws & { connId?: string }).connId;
      if (id) handler.disconnect(id);
    },
  };

  function stop(): void {
    options.logger.setRealtimePublisher(null);
    handler.disconnectAll();
  }

  return { registry, handler, handleUpgrade, websocket, stop };
}

export function isAllowedRealtimeWebSocketOrigin(
  url: string,
  origin: string | null,
  host: string | null,
  requestToken: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredToken = env.GITBOARD_REALTIME_WS_TOKEN ?? "";
  if (configuredToken.length > 0 && requestToken === configuredToken) return true;
  if (!origin || !host) return false;

  try {
    const requestUrl = new URL(url);
    const originUrl = new URL(origin);
    return normalizeHost(host) === normalizeHost(requestUrl.host)
      && originUrl.protocol === requestUrl.protocol
      && normalizeHost(originUrl.host) === normalizeHost(requestUrl.host);
  } catch {
    return false;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:80$/, "").replace(/:443$/, "");
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
