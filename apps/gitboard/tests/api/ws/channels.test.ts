import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "../../../src/api/ws/channels.ts";
import type { Subscriber } from "../../../src/api/ws/channels.ts";

function makeSub(id: string): Subscriber & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    id,
    send: (msg) => messages.push(msg),
    messages,
  };
}

describe("ChannelRegistry", () => {
  it("delivers published messages to subscribers", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("github:activity", sub);
    reg.publish("github:activity", "new_event", { id: "e1" });
    expect(sub.messages).toHaveLength(1);
    expect(sub.messages[0]).toMatchObject({
      type: "event",
      channel: "github:activity",
      event: "new_event",
      seq: 1,
      data: { id: "e1" },
    });
  });

  it("does not deliver to unsubscribed channels", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("system", sub);
    reg.publish("github:activity", "new_event", {});
    expect(sub.messages).toHaveLength(0);
  });

  it("unsubscribe stops delivery", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("github:activity", sub);
    reg.unsubscribe("github:activity", sub);
    reg.publish("github:activity", "new_event", {});
    expect(sub.messages).toHaveLength(0);
  });

  it("unsubscribeAll removes from all channels", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("github:activity", sub);
    reg.subscribe("system", sub);
    reg.unsubscribeAll(sub);
    reg.publish("github:activity", "new_event", {});
    reg.publish("system", "tick", {});
    expect(sub.messages).toHaveLength(0);
  });

  it("subscriberCount returns correct count", () => {
    const reg = new ChannelRegistry();
    const s1 = makeSub("s1");
    const s2 = makeSub("s2");
    expect(reg.subscriberCount("github:activity")).toBe(0);
    reg.subscribe("github:activity", s1);
    reg.subscribe("github:activity", s2);
    expect(reg.subscriberCount("github:activity")).toBe(2);
    reg.unsubscribe("github:activity", s1);
    expect(reg.subscriberCount("github:activity")).toBe(1);
  });

  it("handles multiple subscribers independently", () => {
    const reg = new ChannelRegistry();
    const s1 = makeSub("s1");
    const s2 = makeSub("s2");
    reg.subscribe("github:activity", s1);
    reg.subscribe("github:activity", s2);
    reg.publish("github:activity", "new_event", { id: "e2" });
    expect(s1.messages).toHaveLength(1);
    expect(s2.messages).toHaveLength(1);
  });

  it("removes throwing subscriber on publish", () => {
    const reg = new ChannelRegistry();
    const bad: Subscriber = {
      id: "bad",
      send: () => {
        throw new Error("send failed");
      },
    };
    const good = makeSub("good");
    reg.subscribe("github:activity", bad);
    reg.subscribe("github:activity", good);
    // Should not throw, bad subscriber gets removed
    expect(() => reg.publish("github:activity", "new_event", {})).not.toThrow();
    expect(good.messages).toHaveLength(1);
    expect(reg.subscriberCount("github:activity")).toBe(1);
  });
});
