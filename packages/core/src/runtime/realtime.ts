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
