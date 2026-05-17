import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "../../../src/api/ws/channels.ts";
import { WsHandler } from "../../../src/api/ws/handler.ts";

function makeRaw() {
  const sent: string[] = [];
  return {
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    sent,
  };
}

describe("WsHandler", () => {
  it("connect assigns a unique id", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const r1 = makeRaw();
    const r2 = makeRaw();
    const id1 = handler.connect(r1);
    const id2 = handler.connect(r2);
    expect(id1).not.toBe(id2);
    expect(handler.connectionCount()).toBe(2);
  });

  it("disconnect removes connection", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.disconnect(id);
    expect(handler.connectionCount()).toBe(0);
  });

  it("subscribe routes published messages to connection", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.subscribe(id, "github:activity");
    reg.publish("github:activity", "new_event", { id: "e1" });
    expect(raw.sent).toHaveLength(1);
    const msg = JSON.parse(raw.sent[0]);
    expect(msg.channel).toBe("github:activity");
    expect(msg.event).toBe("new_event");
  });

  it("unsubscribe stops receiving messages", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.subscribe(id, "github:activity");
    handler.unsubscribe(id, "github:activity");
    reg.publish("github:activity", "new_event", {});
    expect(raw.sent).toHaveLength(0);
  });

  it("disconnect unsubscribes from all channels", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.subscribe(id, "github:activity");
    handler.subscribe(id, "system");
    handler.disconnect(id);
    reg.publish("github:activity", "new_event", {});
    reg.publish("system", "tick", {});
    expect(raw.sent).toHaveLength(0);
    expect(reg.subscriberCount("github:activity")).toBe(0);
  });

  it("handleMessage subscribe action subscribes channel", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.handleMessage(id, JSON.stringify({ action: "subscribe", channel: "github:activity", version: "1" }));
    reg.publish("github:activity", "new_event", { id: "e99" });
    expect(raw.sent).toHaveLength(1);
  });

  it("handleMessage unsubscribe action unsubscribes channel", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.handleMessage(id, JSON.stringify({ action: "subscribe", channel: "system", version: "1" }));
    handler.handleMessage(id, JSON.stringify({ action: "unsubscribe", channel: "system" }));
    reg.publish("system", "tick", {});
    expect(raw.sent).toHaveLength(0);
  });

  it("handleMessage ignores invalid JSON", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    expect(() => handler.handleMessage(id, "not-json")).not.toThrow();
  });

  it("handleMessage ignores unknown connection id", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    expect(() =>
      handler.handleMessage("nonexistent", JSON.stringify({ action: "subscribe", channel: "system", version: "1" }))
    ).not.toThrow();
  });
});
