import { REALTIME_PROTOCOL_VERSION } from "../../types/realtime.ts";

export type ChannelName =
  | "github:activity"
  | `github:repo:${string}`
  | "beads:changes"
  | `beads:project:${string}`
  | `session:${string}`
  | `output:${string}`
  | "messages"
  | `protocol:${string}`
  | "system";

export interface WsMessage {
  type: string;
  channel: ChannelName;
  event: string;
  data: unknown;
}

export interface RealtimeEnvelope<E extends string = string, D = unknown> {
  type: "event";
  channel: ChannelName;
  event: E;
  seq: number;
  ts: string;
  version: number;
  boot_id: string;
  data: D;
}

export interface Subscriber {
  id: string;
  send: (msg: WsMessage | RealtimeEnvelope) => void;
}

const RING_BUFFER_SIZE = 500;

export class ChannelRegistry {
  private channels = new Map<string, Set<Subscriber>>();
  private buffers = new Map<string, RealtimeEnvelope[]>();
  private sequenceByChannel = new Map<string, number>();
  private bootId = crypto.randomUUID();

  subscribe(channel: ChannelName, subscriber: Subscriber): void {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel)!.add(subscriber);
  }

  unsubscribe(channel: ChannelName, subscriber: Subscriber): void {
    this.channels.get(channel)?.delete(subscriber);
  }

  unsubscribeAll(subscriber: Subscriber): void {
    for (const subscribers of this.channels.values()) {
      subscribers.delete(subscriber);
    }
  }

  publish(channel: ChannelName, event: string, data: unknown): RealtimeEnvelope {
    const seq = (this.sequenceByChannel.get(channel) ?? 0) + 1;
    this.sequenceByChannel.set(channel, seq);
    const envelope: RealtimeEnvelope = {
      type: "event",
      channel,
      event,
      seq,
      ts: new Date().toISOString(),
      version: REALTIME_PROTOCOL_VERSION,
      boot_id: this.bootId,
      data,
    };
    this.appendToBuffer(channel, envelope);
    const subscribers = this.channels.get(channel);
    if (!subscribers) return envelope;
    for (const sub of subscribers) {
      try {
        sub.send(envelope);
      } catch {
        subscribers.delete(sub);
      }
    }
    return envelope;
  }

  replay(channel: ChannelName, sinceSeq: number, bootId: string): RealtimeEnvelope[] {
    if (bootId !== this.bootId) return [];
    return (this.buffers.get(channel) ?? []).filter((envelope) => envelope.seq > sinceSeq);
  }

  getBootId(): string {
    return this.bootId;
  }

  private appendToBuffer(channel: ChannelName, envelope: RealtimeEnvelope): void {
    const buffer = this.buffers.get(channel) ?? [];
    buffer.push(envelope);
    if (buffer.length > RING_BUFFER_SIZE) buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
    this.buffers.set(channel, buffer);
  }

  hasReplayGap(channel: ChannelName, sinceSeq: number, bootId: string): boolean {
    if (bootId !== this.bootId) return true;
    const buffer = this.buffers.get(channel);
    if (!buffer?.length) return sinceSeq > 0;
    return sinceSeq < buffer[0].seq;
  }

  subscriberCount(channel: ChannelName): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
