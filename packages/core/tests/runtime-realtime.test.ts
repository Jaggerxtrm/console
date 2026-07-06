import { describe, expect, it, vi } from "vitest";
import { REALTIME_PROTOCOL_VERSION, RealtimeChannelRegistry, RealtimeConnectionHandler, type RealtimeSubscriber } from "../src/runtime/index.ts";

function makeRaw() {
  const sent: string[] = [];
  return {
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    sent,
  };
}

function makeSubscriber(id: string): RealtimeSubscriber & { messages: unknown[] } {
  const messages: unknown[] = [];
  return { id, send: (message) => messages.push(message), messages };
}

describe("realtime runtime", () => {
  it("connects, subscribes, unsubscribes, and disconnects websocket clients", () => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw();
    const connectionId = handler.connect(raw);

    handler.handleMessage(connectionId, JSON.stringify({ action: "subscribe", channel: "system", version: String(REALTIME_PROTOCOL_VERSION) }));
    registry.publish("system", "system:log", { event: "first" });
    handler.handleMessage(connectionId, JSON.stringify({ action: "unsubscribe", channel: "system" }));
    registry.publish("system", "system:log", { event: "second" });
    handler.disconnect(connectionId);

    expect(raw.sent).toHaveLength(1);
    expect(JSON.parse(raw.sent[0])).toMatchObject({ channel: "system", event: "system:log", data: { event: "first" } });
    expect(registry.subscriberCount("system")).toBe(0);
    expect(handler.connectionCount()).toBe(0);
  });

  it("keeps monotonic envelopes and replays only requested buffered messages", () => {
    const registry = new RealtimeChannelRegistry();
    const first = registry.publish("github:activity", "github:event.append", { id: "one" });
    const second = registry.publish("github:activity", "github:event.append", { id: "two" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.version).toBe(String(REALTIME_PROTOCOL_VERSION));
    expect(registry.replay("github:activity", 1, registry.getBootId())).toEqual([second]);
  });

  it("removes throwing subscribers without blocking delivery", () => {
    const registry = new RealtimeChannelRegistry();
    const bad: RealtimeSubscriber = { id: "bad", send: () => { throw new Error("send failed"); } };
    const good = makeSubscriber("good");

    registry.subscribe("system", bad);
    registry.subscribe("system", good);
    registry.publish("system", "system:log", { event: "hello" });

    expect(good.messages).toHaveLength(1);
    expect(registry.subscriberCount("system")).toBe(1);
  });

  it("closes connections on protocol mismatch", () => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw();
    const connectionId = handler.connect(raw);

    handler.handleMessage(connectionId, JSON.stringify({ action: "subscribe", channel: "system", version: "0" }));

    expect(raw.close).toHaveBeenCalledWith(4001);
  });

  it("emits sync hint when resume cannot replay requested buffer", () => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw();
    const connectionId = handler.connect(raw);

    handler.handleMessage(connectionId, JSON.stringify({ action: "resume", channel: "github:activity", since_seq: 1, boot_id: "other" }));

    expect(JSON.parse(raw.sent[0])).toMatchObject({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 1 } });
  });
});
