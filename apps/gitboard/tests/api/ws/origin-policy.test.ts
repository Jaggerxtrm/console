import { describe, expect, it } from "vitest";
import { isAllowedRealtimeWebSocketOrigin } from "../../../src/api/server.ts";

describe("realtime websocket origin policy", () => {
  it("allows same-origin dashboard websocket upgrades", () => {
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://localhost:3030/ws",
      "http://localhost:3030",
      "localhost:3030",
      null,
      {},
    )).toBe(true);
  });

  it("rejects hostile or missing origins", () => {
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://localhost:3030/ws",
      "https://evil.example",
      "localhost:3030",
      null,
      {},
    )).toBe(false);

    expect(isAllowedRealtimeWebSocketOrigin(
      "http://localhost:3030/ws",
      null,
      "localhost:3030",
      null,
      {},
    )).toBe(false);
  });

  it("rejects host spoofing where request URL and Host disagree", () => {
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://100.113.49.52:3030/ws",
      "http://localhost:3030",
      "localhost:3030",
      null,
      {},
    )).toBe(false);
  });

  it("allows explicit service token override", () => {
    expect(isAllowedRealtimeWebSocketOrigin(
      "http://100.113.49.52:3030/ws",
      null,
      "100.113.49.52:3030",
      "secret",
      { GITBOARD_REALTIME_WS_TOKEN: "secret" },
    )).toBe(true);
  });
});
