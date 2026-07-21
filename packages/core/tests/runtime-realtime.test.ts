import { describe, expect, it, vi } from "vitest";
import { REALTIME_PROTOCOL_VERSION, RealtimeChannelRegistry, RealtimeConnectionHandler, type RealtimeSendResult, type RealtimeSubscriber } from "../src/runtime/index.ts";

function makeRaw(sendResult: RealtimeSendResult = undefined) {
  const sent: string[] = [];
  return {
    send: (data: string) => {
      sent.push(data);
      return sendResult;
    },
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

  it("replays buffered envelopes in sequence order without crossing channels", () => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw();
    const connectionId = handler.connect(raw);
    handler.subscribe(connectionId, "system");
    handler.subscribe(connectionId, "github:activity");
    registry.publish("system", "system:log", { source: "system-only" });
    registry.publish("github:activity", "github:event.append", { source: "github-only" });
    registry.publish("system", "system:log", { source: "system-second" });
    registry.publish("system", "system:log", { source: "system-third" });
    raw.sent.length = 0;

    handler.resume(connectionId, "system", 1, registry.getBootId());

    expect(raw.sent.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ channel: "system", seq: 2, data: { source: "system-second" } }),
      expect.objectContaining({ channel: "system", seq: 3, data: { source: "system-third" } }),
    ]);
    expect(raw.sent.some((message) => message.includes("github-only"))).toBe(false);
  });

  it.each([
    { label: "false", result: false as const, status: "backpressure" as const },
    { label: "zero", result: 0 as const, status: "dropped" as const },
  ])("disconnects and reports $label send results", ({ result, status }) => {
    const registry = new RealtimeChannelRegistry();
    const backpressure: unknown[] = [];
    const handler = new RealtimeConnectionHandler(registry, { onBackpressure: (event) => backpressure.push(event) });
    const raw = makeRaw(result);
    const connectionId = handler.connect(raw);
    handler.subscribe(connectionId, "system");

    registry.publish("system", "system:log", { secret: "must-not-enter-telemetry" });

    expect(raw.close).toHaveBeenCalledWith(1013);
    expect(handler.connectionCount()).toBe(0);
    expect(registry.subscriberCount("system")).toBe(0);
    expect(backpressure).toEqual([expect.objectContaining({ channel: "system", status, bytes: expect.any(Number) })]);
    expect(JSON.stringify(backpressure)).not.toContain("must-not-enter-telemetry");
  });

  it.each([
    { label: "void", result: undefined },
    { label: "true", result: true },
    { label: "positive number", result: 1 },
  ])("keeps $label send results compatible", ({ result }) => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw(result);
    const connectionId = handler.connect(raw);
    handler.subscribe(connectionId, "system");

    registry.publish("system", "system:log", { event: "delivered" });

    expect(raw.sent).toHaveLength(1);
    expect(raw.close).not.toHaveBeenCalled();
    expect(handler.connectionCount()).toBe(1);
  });

  it("sync-hints instead of sending an oversized replay batch", () => {
    const registry = new RealtimeChannelRegistry();
    const handler = new RealtimeConnectionHandler(registry);
    const raw = makeRaw();
    const connectionId = handler.connect(raw);
    const payload = { blob: "x".repeat(600_000) };
    registry.publish("github:activity", "github:event.append", payload);
    registry.publish("github:activity", "github:event.append", payload);
    registry.publish("github:activity", "github:event.append", payload);

    handler.resume(connectionId, "github:activity", 1, registry.getBootId());

    expect(raw.sent).toHaveLength(1);
    expect(JSON.parse(raw.sent[0])).toMatchObject({ event: "github:sync_hint", data: { reason: "replay_overload" } });
  });

  it("disconnects slow raw connections across reconnect cycles", () => {
    const registry = new RealtimeChannelRegistry();
    const backpressure = [] as Array<{ id: string; channel: string; bytes: number; status: string }>;
    const handler = new RealtimeConnectionHandler(registry, { onBackpressure: (event) => backpressure.push(event) });

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const close = vi.fn();
      const raw = { send: vi.fn(() => -1), close };
      const connectionId = handler.connect(raw);
      handler.subscribe(connectionId, "system");
      registry.publish("system", "system:log", { event: `slow-client-${cycle}` });

      expect(close).toHaveBeenCalledWith(1013);
      expect(handler.connectionCount()).toBe(0);
    }

    expect(registry.subscriberCount("system")).toBe(0);
    expect(backpressure).toHaveLength(20);
    expect(backpressure.every((event) => event.bytes > 0 && event.status === "backpressure")).toBe(true);
  });
});
