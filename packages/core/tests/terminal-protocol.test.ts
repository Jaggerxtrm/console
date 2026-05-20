import { describe, expect, it } from "vitest";
import {
  TERMINAL_STREAM_PROTOCOL_VERSION,
  TERMINAL_SESSION_TRANSITIONS,
  createTerminalStreamEnvelope,
  estimateTerminalOutputBackpressure,
  isTerminalLifecycleTransitionAllowed,
  validateTerminalStreamMessage,
} from "../src/terminal/protocol.ts";

describe("terminal stream protocol", () => {
  it("creates open envelope", () => {
    const envelope = createTerminalStreamEnvelope("open", "stream-1", "session-1", {
      providerKind: "pty",
      capabilities: ["interactive", "resizable"],
    });

    expect(envelope.version).toBe(TERMINAL_STREAM_PROTOCOL_VERSION);
    expect(envelope.kind).toBe("open");
    expect(validateTerminalStreamMessage(envelope)).toBe(true);
  });

  it("validates attach detach input output resize exit error status heartbeat", () => {
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "attach", streamId: "s", sessionId: "x", timestamp: "t", payload: { resume: true, reattachToken: "tok" } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "attach", streamId: "s", sessionId: "x", timestamp: "t", payload: { resume: true } })).toBe(false);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "attach", streamId: "s", sessionId: "x", timestamp: "t", payload: { resume: true, token: "tok" } })).toBe(false);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "detach", streamId: "s", sessionId: "x", timestamp: "t", payload: { reason: "done" } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "input", streamId: "s", sessionId: "x", timestamp: "t", payload: { data: "ls\n", encoding: "utf8" } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "output", streamId: "s", sessionId: "x", timestamp: "t", payload: { data: "out", encoding: "base64", sequence: 1, bytes: 3 } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "resize", streamId: "s", sessionId: "x", timestamp: "t", payload: { cols: 80, rows: 24 } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "exit", streamId: "s", sessionId: "x", timestamp: "t", payload: { code: 0, signal: null } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "error", streamId: "s", sessionId: "x", timestamp: "t", payload: { code: "EFAIL", message: "fail", recoverable: false } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "status", streamId: "s", sessionId: "x", timestamp: "t", payload: { state: "open", attached: true, paused: false, bytesIn: 1, bytesOut: 2, backlogBytes: 0 } })).toBe(true);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "heartbeat", streamId: "s", sessionId: "x", timestamp: "t", payload: { ack: 7 } })).toBe(true);
  });

  it("rejects invalid message shape", () => {
    expect(validateTerminalStreamMessage({})).toBe(false);
    expect(validateTerminalStreamMessage({ version: 1, kind: "open", streamId: "s", sessionId: "x", timestamp: "t", payload: {} })).toBe(false);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "open", streamId: "s", sessionId: "x", timestamp: "t", payload: { providerKind: "bad", capabilities: [] } })).toBe(false);
    expect(validateTerminalStreamMessage({ version: "1.0.0", kind: "open", streamId: "s", sessionId: "x", timestamp: "t", payload: { providerKind: "pty", capabilities: ["nope"] } })).toBe(false);
  });

  it("allows only valid lifecycle transitions", () => {
    expect(isTerminalLifecycleTransitionAllowed("opening", "open")).toBe(true);
    expect(isTerminalLifecycleTransitionAllowed("open", "attached")).toBe(true);
    expect(isTerminalLifecycleTransitionAllowed("open", "opening")).toBe(false);
    expect(TERMINAL_SESSION_TRANSITIONS.exited).toEqual([]);
  });

  it("describes backpressure", () => {
    expect(estimateTerminalOutputBackpressure(10, 0)).toBe("flowing");
    expect(estimateTerminalOutputBackpressure(10, 1024)).toBe("buffered");
    expect(estimateTerminalOutputBackpressure(10, 128 * 1024)).toBe("throttled");
  });
});
