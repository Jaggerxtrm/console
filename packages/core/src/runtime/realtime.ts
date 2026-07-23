export const REALTIME_PROTOCOL_VERSION = 1 as const;

export type RealtimeProtocolVersion = typeof REALTIME_PROTOCOL_VERSION;

export type RealtimeChannelName =
  | "github:activity"
  | `github:repo:${string}`
  | "substrate:changes"
  | `substrate:project:${string}`
  | "specialists:activity"
  | `specialists:repo:${string}`
  | `session:${string}`
  | `output:${string}`
  | "messages"
  | `protocol:${string}`
  | "system";

export interface RealtimeMessage {
  type: string;
  channel: RealtimeChannelName;
  event: string;
  data: unknown;
}

export interface RealtimeEnvelope<E extends string = string, D = unknown> {
  type: "event";
  channel: RealtimeChannelName;
  event: E;
  seq: number;
  ts: string;
  version: string;
  boot_id: string;
  data: D;
}

export interface RealtimeSubscriber {
  id: string;
  send: (msg: RealtimeMessage | RealtimeEnvelope) => void;
}

export interface RealtimeRegistry {
  subscribe(channel: RealtimeChannelName, subscriber: RealtimeSubscriber): void;
  unsubscribe(channel: RealtimeChannelName, subscriber: RealtimeSubscriber): void;
  unsubscribeAll(subscriber: RealtimeSubscriber): void;
  publish(channel: RealtimeChannelName, event: string, data: unknown, version?: string): RealtimeEnvelope;
  replay(channel: RealtimeChannelName, sinceSeq: number, bootId: string): RealtimeEnvelope[];
  hasReplayGap(channel: RealtimeChannelName, sinceSeq: number, bootId: string): boolean;
  getBootId(): string;
}

export interface RealtimeConnection {
  id: string;
  raw: RealtimeRawConnection;
  subscriptions: Set<RealtimeChannelName>;
  subscriber?: RealtimeSubscriber;
}

export interface RealtimeRawConnection {
  send(data: string): RealtimeSendResult;
  close(code?: number): void;
}

export interface RealtimeConnectionHandlerOptions {
  readonly onConnect?: (id: string) => void;
  readonly onDisconnect?: (id: string) => void;
  readonly onVersionMismatch?: (event: { readonly id: string; readonly channel: RealtimeChannelName; readonly version: unknown }) => void;
  readonly onBackpressure?: (event: { readonly id: string; readonly channel: RealtimeChannelName; readonly bytes: number; readonly status: "backpressure" | "dropped" }) => void;
}

export type RealtimeSendResult = void | boolean | number;

const RING_BUFFER_SIZE = 500;
const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;
const BACKPRESSURE_CLOSE_CODE = 1013;
const textEncoder = new TextEncoder();
const STATIC_CHANNELS = new Set(["github:activity", "substrate:changes", "specialists:activity", "messages", "system"]);
const DYNAMIC_CHANNEL_PATTERN = /^(github:repo|substrate:project|specialists:repo|session|output|protocol):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const RESERVED_CHANNEL_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function isAllowedRealtimeChannel(channel: unknown): channel is RealtimeChannelName {
  if (typeof channel !== "string" || channel.length > 256) return false;
  if (STATIC_CHANNELS.has(channel)) return true;
  const match = DYNAMIC_CHANNEL_PATTERN.exec(channel);
  return Boolean(match && !RESERVED_CHANNEL_SEGMENTS.has(match[2]));
}

export class RealtimeChannelRegistry implements RealtimeRegistry {
  private readonly channels = new Map<string, Set<RealtimeSubscriber>>();
  private readonly buffers = new Map<string, RealtimeEnvelope[]>();
  private readonly sequenceByChannel = new Map<string, number>();
  private readonly bootId = crypto.randomUUID();

  subscribe(channel: RealtimeChannelName, subscriber: RealtimeSubscriber): void {
    if (!isAllowedRealtimeChannel(channel)) return;
    const subscribers = this.channels.get(channel) ?? new Set<RealtimeSubscriber>();
    subscribers.add(subscriber);
    this.channels.set(channel, subscribers);
  }

  unsubscribe(channel: RealtimeChannelName, subscriber: RealtimeSubscriber): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (subscribers.size === 0) this.channels.delete(channel);
  }

  unsubscribeAll(subscriber: RealtimeSubscriber): void {
    for (const [channel, subscribers] of this.channels) {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.channels.delete(channel);
    }
  }

  publish(channel: RealtimeChannelName, event: string, data: unknown, version?: string): RealtimeEnvelope {
    const seq = (this.sequenceByChannel.get(channel) ?? 0) + 1;
    this.sequenceByChannel.set(channel, seq);
    const envelope: RealtimeEnvelope = {
      type: "event",
      channel,
      event,
      seq,
      ts: new Date().toISOString(),
      version: version ?? String(REALTIME_PROTOCOL_VERSION),
      boot_id: this.bootId,
      data,
    };
    this.appendToBuffer(channel, envelope);
    this.publishToSubscribers(channel, envelope);
    return envelope;
  }

  replay(channel: RealtimeChannelName, sinceSeq: number, bootId: string): RealtimeEnvelope[] {
    if (bootId !== this.bootId) return [];
    return (this.buffers.get(channel) ?? []).filter((envelope) => envelope.seq > sinceSeq);
  }

  hasReplayGap(channel: RealtimeChannelName, sinceSeq: number, bootId: string): boolean {
    if (bootId !== this.bootId) return true;
    const buffer = this.buffers.get(channel);
    if (!buffer?.length) return sinceSeq > 0;
    return sinceSeq < buffer[0].seq;
  }

  getBootId(): string {
    return this.bootId;
  }

  subscriberCount(channel: RealtimeChannelName): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  private publishToSubscribers(channel: RealtimeChannelName, envelope: RealtimeEnvelope): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      try {
        subscriber.send(envelope);
      } catch {
        subscribers.delete(subscriber);
      }
    }
    if (subscribers.size === 0) this.channels.delete(channel);
  }

  private appendToBuffer(channel: RealtimeChannelName, envelope: RealtimeEnvelope): void {
    const buffer = this.buffers.get(channel) ?? [];
    buffer.push(envelope);
    if (buffer.length > RING_BUFFER_SIZE) buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
    this.buffers.set(channel, buffer);
  }
}

export class RealtimeConnectionHandler {
  private readonly connections = new Map<string, RealtimeConnection>();
  private nextId = 1;

  constructor(
    private readonly registry: RealtimeRegistry,
    private readonly options: RealtimeConnectionHandlerOptions = {},
  ) {}

  connect(raw: RealtimeRawConnection): string {
    const id = `ws-${this.nextId++}`;
    const connection: RealtimeConnection = { id, raw, subscriptions: new Set() };
    connection.subscriber = this.createSubscriber(connection);
    this.connections.set(id, connection);
    this.options.onConnect?.(id);
    return id;
  }

  subscribe(connectionId: string, channel: RealtimeChannelName): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.subscriber || !isAllowedRealtimeChannel(channel)) return;
    if (connection.subscriptions.has(channel) || connection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return;
    connection.subscriptions.add(channel);
    this.registry.subscribe(channel, connection.subscriber);
  }

  unsubscribe(connectionId: string, channel: RealtimeChannelName): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.subscriber || !isAllowedRealtimeChannel(channel)) return;
    connection.subscriptions.delete(channel);
    this.registry.unsubscribe(channel, connection.subscriber);
  }

  resume(connectionId: string, channel: RealtimeChannelName, sinceSeq: number, bootId?: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.subscriber || !isAllowedRealtimeChannel(channel)) return;
    if (this.registry.hasReplayGap(channel, sinceSeq, bootId ?? "")) {
      this.send(connection, JSON.stringify(createSyncHint(channel, sinceSeq)), channel);
      return;
    }

    const replay = this.registry.replay(channel, sinceSeq, bootId ?? "");
    const serialized: string[] = [];
    let replayBytes = 0;
    for (const envelope of replay) {
      const message = JSON.stringify(envelope);
      const bytes = byteLength(message);
      if (replayBytes + bytes > MAX_REPLAY_BYTES) {
        this.send(connection, JSON.stringify(createSyncHint(channel, sinceSeq, "replay_overload")), channel);
        return;
      }
      serialized.push(message);
      replayBytes += bytes;
    }
    for (const message of serialized) {
      if (!this.send(connection, message, channel)) return;
    }
  }

  disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.subscriber) return;
    this.registry.unsubscribeAll(connection.subscriber);
    this.connections.delete(connectionId);
    this.options.onDisconnect?.(connectionId);
  }

  disconnectAll(closeCode = 1001): void {
    for (const [connectionId, connection] of [...this.connections]) {
      try {
        connection.raw.close(closeCode);
      } catch {}
      this.disconnect(connectionId);
    }
  }

  handleMessage(connectionId: string, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) return;

    if (message.action === "subscribe") {
      if (message.version !== String(REALTIME_PROTOCOL_VERSION)) {
        this.options.onVersionMismatch?.({ id: connectionId, channel: message.channel, version: message.version });
        this.connections.get(connectionId)?.raw.close(4001);
        return;
      }
      this.subscribe(connectionId, message.channel);
      return;
    }

    if (message.action === "unsubscribe") {
      this.unsubscribe(connectionId, message.channel);
      return;
    }

    this.resume(connectionId, message.channel, message.since_seq ?? 0, message.boot_id);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  private createSubscriber(connection: RealtimeConnection): RealtimeSubscriber {
    return {
      id: connection.id,
      send: (message) => {
        this.send(connection, JSON.stringify(message), message.channel);
      },
    };
  }

  private send(connection: RealtimeConnection, message: string, channel: RealtimeChannelName): boolean {
    const bytes = byteLength(message);
    try {
      const result = connection.raw.send(message);
      if (result === false || (typeof result === "number" && result <= 0)) {
        try {
          connection.raw.close(BACKPRESSURE_CLOSE_CODE);
        } catch {}
        this.disconnect(connection.id);
        const status = result === 0 ? "dropped" : "backpressure";
        this.options.onBackpressure?.({ id: connection.id, channel, bytes, status });
        return false;
      }
      return true;
    } catch {
      this.disconnect(connection.id);
      return false;
    }
  }
}

function byteLength(message: string): number {
  return textEncoder.encode(message).byteLength;
}

type ClientMessage =
  | { readonly action: "subscribe"; readonly channel: RealtimeChannelName; readonly version: unknown }
  | { readonly action: "unsubscribe"; readonly channel: RealtimeChannelName }
  | { readonly action: "resume"; readonly channel: RealtimeChannelName; readonly since_seq?: number; readonly boot_id?: string };

function parseClientMessage(raw: string): ClientMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isClientMessageObject(message) || !isAllowedRealtimeChannel(message.channel)) return null;
  if (message.action === "subscribe") return { action: "subscribe", channel: message.channel, version: message.version };
  if (message.action === "unsubscribe") return { action: "unsubscribe", channel: message.channel };
  if (message.action === "resume") {
    const sinceSeq = typeof message.since_seq === "number" ? message.since_seq : undefined;
    const bootId = typeof message.boot_id === "string" ? message.boot_id : undefined;
    return { action: "resume", channel: message.channel, since_seq: sinceSeq, boot_id: bootId };
  }
  return null;
}

function isClientMessageObject(message: unknown): message is Record<string, unknown> & { channel: RealtimeChannelName; action: string } {
  return typeof message === "object" && message !== null && "action" in message && "channel" in message;
}

function createSyncHint(channel: RealtimeChannelName, sinceSeq: number, reason = "buffer_miss"): RealtimeMessage {
  const event = channel.startsWith("substrate:") ? "substrate:sync_hint" : channel.startsWith("specialists:") ? "specialists:sync_hint" : "github:sync_hint";
  return { type: "event", channel, event, data: { reason, channel, since_seq: sinceSeq } };
}
