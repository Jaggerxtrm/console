import { describe, expect, it, vi } from "vitest";
import { makeLogEntry } from "../../../../../packages/core/src/runtime/logs.ts";
import { REALTIME_PROTOCOL_VERSION } from "../../../../../packages/core/src/runtime/realtime.ts";
import { createHostLogger } from "../../../src/server/log.ts";
import {
  createConsoleRealtime,
  isAllowedRealtimeWebSocketOrigin,
} from "../../../src/server/ws/realtime.ts";

function makeSocket(path = "/api/console/ws") {
  const sent: string[] = [];
  return {
    data: { path },
    send: vi.fn((message: string) => { sent.push(message); return message.length; }),
    close: vi.fn(),
    sent,
  };
}

describe("Console realtime boundary", () => {
  it("preserves same-origin and compatibility-token policy", () => {
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://console.test/api/console/ws",
      "http://console.test",
      "console.test",
      null,
      {},
    )).toBe(true);
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://console.test/api/console/ws",
      "https://hostile.test",
      "console.test",
      null,
      {},
    )).toBe(false);
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://console.test/api/console/ws",
      null,
      "console.test",
      "test-token",
      { GITBOARD_REALTIME_WS_TOKEN: "test-token" },
    )).toBe(true);
  });

  it("handles Bun upgrade, handshake, subscribe, replay and disconnect without payload logging", () => {
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const realtime = createConsoleRealtime({ logger });
    const server = { upgrade: vi.fn(() => true) };
    const request = new Request("http://console.test/api/console/ws", {
      headers: { host: "console.test", origin: "http://console.test", upgrade: "websocket" },
    });

    expect(realtime.handleUpgrade(request, server as never, "127.0.0.1")).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(request, { data: { path: "/api/console/ws" } });

    const first = makeSocket();
    realtime.websocket.open?.(first as never);
    expect(JSON.parse(first.sent[0])).toMatchObject({ type: "connected", id: "ws-1" });
    realtime.websocket.message(first as never, JSON.stringify({
      action: "subscribe",
      channel: "system",
      version: String(REALTIME_PROTOCOL_VERSION),
      payload: "known-secret-payload",
    }));

    logger.emit(makeLogEntry("system", "realtime.first", "info"));
    const firstEnvelope = JSON.parse(first.sent[1]) as { seq: number; boot_id: string; event: string };
    expect(firstEnvelope).toMatchObject({ event: "system:log" });

    realtime.websocket.close?.(first as never, 1000, "done");
    logger.emit(makeLogEntry("system", "realtime.buffered", "info"));

    const second = makeSocket();
    realtime.websocket.open?.(second as never);
    realtime.websocket.message(second as never, JSON.stringify({
      action: "resume",
      channel: "system",
      since_seq: firstEnvelope.seq,
      boot_id: firstEnvelope.boot_id,
    }));
    const replay = second.sent.slice(1).map((message) => JSON.parse(message));
    expect(replay).toEqual(expect.arrayContaining([expect.objectContaining({
      channel: "system",
      event: "system:log",
      data: expect.objectContaining({ event: "realtime.buffered" }),
    })]));
    expect(replay.every((message) => message.seq > firstEnvelope.seq)).toBe(true);

    expect(JSON.stringify(logger.getRing())).not.toContain("known-secret-payload");
    expect(realtime.handler.connectionCount()).toBe(1);
    realtime.websocket.close?.(second as never, 1000, "done");
    expect(realtime.handler.connectionCount()).toBe(0);
  });

  it("rejects hostile origins and spoofed localhost peers before upgrade", async () => {
    const realtime = createConsoleRealtime({ logger: createHostLogger({ sink: () => {}, diskEnabled: false }) });
    const server = { upgrade: vi.fn(() => true) };
    const hostile = new Request("http://console.test/api/console/ws", {
      headers: { host: "console.test", origin: "https://hostile.test", upgrade: "websocket" },
    });
    const spoofed = new Request("http://localhost/api/console/ws", {
      headers: { host: "localhost", origin: "http://localhost", upgrade: "websocket" },
    });

    const hostileResponse = realtime.handleUpgrade(hostile, server as never, "127.0.0.1");
    const spoofedResponse = realtime.handleUpgrade(spoofed, server as never, "203.0.113.20");

    expect(hostileResponse).toBeInstanceOf(Response);
    expect((hostileResponse as Response).status).toBe(403);
    await expect((hostileResponse as Response).json()).resolves.toEqual({ error: "websocket origin denied" });
    expect(spoofedResponse).toBeInstanceOf(Response);
    expect((spoofedResponse as Response).status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  it("keeps protocol mismatch and backpressure close codes", () => {
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const realtime = createConsoleRealtime({ logger });
    const mismatch = makeSocket();
    realtime.websocket.open?.(mismatch as never);
    realtime.websocket.message(mismatch as never, JSON.stringify({ action: "subscribe", channel: "system", version: "known-secret-version" }));
    expect(mismatch.close).toHaveBeenCalledWith(4001);
    expect(JSON.stringify(logger.getRing())).not.toContain("known-secret-version");
    expect(logger.getRing()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "subscribe.version_mismatch", data: expect.objectContaining({ version: "[INVALID]" }) }),
    ]));

    const numericSecret = makeSocket();
    realtime.websocket.open?.(numericSecret as never);
    realtime.websocket.message(numericSecret as never, JSON.stringify({ action: "subscribe", channel: "system", version: "87654321" }));
    expect(JSON.stringify(logger.getRing())).not.toContain("87654321");

    const slow = makeSocket();
    slow.send.mockImplementation(() => -1);
    realtime.websocket.open?.(slow as never);
    realtime.websocket.message(slow as never, JSON.stringify({ action: "subscribe", channel: "system", version: "1" }));
    realtime.registry.publish("system", "system:log", { marker: "slow" });
    expect(slow.close).toHaveBeenCalledWith(1013);
  });
});
