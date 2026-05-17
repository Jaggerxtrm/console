import { describe, it, expect, vi } from "vitest";
import { REALTIME_PROTOCOL_VERSION } from "../../../src/types/realtime.ts";
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

function makeSub(id: string) {
  const messages: unknown[] = [];
  return {
    id,
    send: (msg: unknown) => messages.push(msg),
    messages,
  };
}

describe("realtime contract", () => {
  it("publishes envelope with seq ts version", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("github:activity", sub);
    reg.publish("github:activity", "new_event", { id: "e1" });
    const msg = sub.messages[0] as Record<string, unknown>;
    expect(msg).toMatchObject({
      type: "event",
      channel: "github:activity",
      event: "new_event",
      seq: 1,
      version: REALTIME_PROTOCOL_VERSION,
      data: { id: "e1" },
    });
    expect(typeof msg.ts).toBe("string");
  });

  it("keeps seq monotonic", () => {
    const reg = new ChannelRegistry();
    const sub = makeSub("s1");
    reg.subscribe("github:activity", sub);
    expect(reg.publish("github:activity", "new_event", {}).seq).toBe(1);
    expect(reg.publish("github:activity", "new_event", {}).seq).toBe(2);
  });

  it("replays buffered envelopes after since_seq", () => {
    const reg = new ChannelRegistry();
    reg.publish("github:activity", "new_event", { id: "e1" });
    reg.publish("github:activity", "new_event", { id: "e2" });
    const replay = reg.replay("github:activity", 1, reg.getBootId());
    expect(replay).toHaveLength(1);
    expect(replay[0].seq).toBe(2);
  });

  it("closes on protocol version mismatch", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    handler.handleMessage(id, JSON.stringify({ action: "subscribe", channel: "github:activity", version: 0 }));
    expect(raw.close).toHaveBeenCalledWith(4001);
  });

  it("resume with mismatched boot_id emits sync_hint with reason buffer_miss", () => {
    const reg = new ChannelRegistry();
    const handler = new WsHandler(reg);
    const raw = makeRaw();
    const id = handler.connect(raw);
    const envelope = reg.publish("github:activity", "new_event", { id: "e1" });
    handler.resume(id, "github:activity", 0, "other-boot-id");

    expect(raw.sent).toHaveLength(1);
    const msg = JSON.parse(raw.sent[0]) as { event?: string; data?: { reason?: string } };
    expect(msg.event?.endsWith(":sync_hint")).toBe(true);
    expect(msg.data?.reason).toBe("buffer_miss");
    expect(envelope.boot_id).toBe(reg.getBootId());
  });
});
