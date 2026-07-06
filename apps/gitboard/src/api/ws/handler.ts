import { RealtimeConnectionHandler, REALTIME_PROTOCOL_VERSION } from "../../../../../packages/core/src/runtime/index.ts";
import { emit, makeLogEntry } from "../../core/logger.ts";
import type { ChannelName, ChannelRegistry, Subscriber, WsMessage } from "./channels.ts";

export interface WsConnection {
  id: string;
  raw: { send(data: string): void; close(code?: number): void };
  subscriptions: Set<ChannelName>;
  subscriber?: Subscriber;
}

export class WsHandler extends RealtimeConnectionHandler {
  constructor(registry: ChannelRegistry) {
    super(registry, {
      onConnect: (id) => emit(makeLogEntry("ws", "client.connected", "info", undefined, { id })),
      onDisconnect: (id) => emit(makeLogEntry("ws", "client.disconnected", "info", undefined, { id })),
      onVersionMismatch: ({ id, channel, version }) => {
        emit(makeLogEntry("ws", "subscribe.version_mismatch", "warn", undefined, { id, channel, version }));
      },
    });
  }
}

export { REALTIME_PROTOCOL_VERSION };
export type { ChannelName, Subscriber, WsMessage };
