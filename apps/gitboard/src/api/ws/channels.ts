import {
  RealtimeChannelRegistry,
  type RealtimeChannelName,
  type RealtimeEnvelope,
  type RealtimeMessage,
  type RealtimeSubscriber,
} from "../../../../../packages/core/src/runtime/index.ts";

export type ChannelName = RealtimeChannelName;
export interface WsMessage extends RealtimeMessage {}
export interface Subscriber extends RealtimeSubscriber {}

export class ChannelRegistry extends RealtimeChannelRegistry {
  publish(channel: ChannelName, event: string, data: unknown, version?: string): RealtimeEnvelope {
    return super.publish(channel, event, data, version);
  }
}
