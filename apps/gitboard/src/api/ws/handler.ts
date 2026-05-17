import { REALTIME_PROTOCOL_VERSION } from "../../types/realtime.ts";
import type { ChannelName, ChannelRegistry, Subscriber, WsMessage } from "./channels.ts";

export interface WsConnection {
  id: string;
  raw: { send(data: string): void; close(code?: number): void };
  subscriptions: Set<ChannelName>;
  subscriber?: Subscriber;
}

type SubscribeMessage = {
  action: "subscribe";
  channel: ChannelName;
  version: number;
};

type UnsubscribeMessage = {
  action: "unsubscribe";
  channel: ChannelName;
};

type ResumeMessage = {
  action: "resume";
  channel: ChannelName;
  since_seq: number;
  boot_id?: string;
};

export class WsHandler {
  private connections = new Map<string, WsConnection>();
  private registry: ChannelRegistry;
  private nextId = 1;

  constructor(registry: ChannelRegistry) {
    this.registry = registry;
  }

  connect(raw: WsConnection["raw"]): string {
    const id = `ws-${this.nextId++}`;
    const conn: WsConnection = { id, raw, subscriptions: new Set() };
    this.connections.set(id, conn);

    const subscriber: Subscriber = {
      id,
      send: (msg: WsMessage) => {
        try {
          raw.send(JSON.stringify(msg));
        } catch {
          this.disconnect(id);
        }
      },
    };

    conn.subscriber = subscriber;
    return id;
  }

  subscribe(connId: string, channel: ChannelName): void {
    const conn = this.connections.get(connId);
    if (!conn?.subscriber) return;
    conn.subscriptions.add(channel);
    this.registry.subscribe(channel, conn.subscriber);
  }

  unsubscribe(connId: string, channel: ChannelName): void {
    const conn = this.connections.get(connId);
    if (!conn?.subscriber) return;
    conn.subscriptions.delete(channel);
    this.registry.unsubscribe(channel, conn.subscriber);
  }

  resume(connId: string, channel: ChannelName, sinceSeq: number, bootId?: string): void {
    const conn = this.connections.get(connId);
    if (!conn?.subscriber) return;
    const replay = this.registry.replay(channel, sinceSeq, bootId ?? "");
    if (this.registry.hasReplayGap(channel, sinceSeq, bootId ?? "")) {
      conn.raw.send(
        JSON.stringify({
          type: "event",
          channel,
          event: channel.startsWith("beads:") ? "beads:sync_hint" : "github:sync_hint",
          data: { reason: "buffer_miss", channel, since_seq: sinceSeq },
        }),
      );
      return;
    }
    for (const envelope of replay) {
      conn.raw.send(JSON.stringify(envelope));
    }
  }

  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    if (!conn?.subscriber) return;
    this.registry.unsubscribeAll(conn.subscriber);
    this.connections.delete(connId);
  }

  handleMessage(connId: string, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof msg !== "object" || msg === null || !("action" in msg) || !("channel" in msg)) {
      return;
    }

    const action = (msg as { action: string }).action;
    const channel = (msg as { channel: ChannelName }).channel;

    if (action === "subscribe") {
      const version = (msg as Partial<SubscribeMessage>).version;
      if (version !== REALTIME_PROTOCOL_VERSION) {
        this.connections.get(connId)?.raw.close(4001);
        return;
      }
      this.subscribe(connId, channel);
    } else if (action === "unsubscribe") {
      this.unsubscribe(connId, channel);
    } else if (action === "resume") {
      this.resume(connId, channel, (msg as Partial<ResumeMessage>).since_seq ?? 0, (msg as Partial<ResumeMessage>).boot_id);
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }
}
