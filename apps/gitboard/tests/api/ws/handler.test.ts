import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "../../../src/api/ws/channels.ts";
import { WsHandler } from "../../../src/api/ws/handler.ts";
import { getRing, setDiskEnabled } from "../../../src/core/logger.ts";

function makeRaw(sendResult?: boolean | number) {
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

  it("disconnects backpressured channel without cross-channel or payload leakage", () => {
    setDiskEnabled(false);
    const before = getRing().length;
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const slow = makeRaw(-1);
    const healthy = makeRaw();
    const slowId = handler.connect(slow);
    const healthyId = handler.connect(healthy);
    handler.subscribe(slowId, "system");
    handler.subscribe(healthyId, "github:activity");

    reg.publish("github:activity", "github:event.append", { marker: "github-only" });
    expect(healthy.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    reg.publish("system", "system:log", { marker: "secret-log-body" });

    expect(slow.close).toHaveBeenCalledWith(1013);
    expect(handler.connectionCount()).toBe(1);
    const backpressureLogs = getRing().slice(before).filter((entry) => entry.event === "ws.publish.backpressure");
    expect(backpressureLogs).toEqual([
      expect.objectContaining({
        component: "ws",
        level: "warn",
        data: expect.objectContaining({ channel: "system", status: "backpressure", bytes: expect.any(Number) }),
      }),
    ]);
    expect(JSON.stringify(backpressureLogs)).not.toContain("secret-log-body");
    expect(JSON.stringify(backpressureLogs)).not.toContain("github-only");
  });
});
