import { describe, expect, it, vi } from "vitest";
import { createTerminalStreamEnvelope } from "../../../../../packages/core/src/terminal/protocol.ts";
import { TerminalBridge } from "../../../src/api/terminal/bridge.ts";
import type { TerminalProvider, TerminalProviderRegistry, TerminalProviderSession } from "../../../src/api/terminal/provider-registry.ts";

class MockSession implements TerminalProviderSession {
  outputs: Array<(data: string) => void> = [];
  exits: Array<(code: number | null, signal: string | null) => void> = [];
  inputs: string[] = [];
  sizes: Array<{ cols: number; rows: number }> = [];
  disposed: string[] = [];

  onOutput(listener: (data: string) => void): () => void { this.outputs.push(listener); return () => {}; }
  onExit(listener: (code: number | null, signal: string | null) => void): () => void { this.exits.push(listener); return () => {}; }
  async input(data: string): Promise<void> { this.inputs.push(data); }
  async resize(cols: number, rows: number): Promise<void> { this.sizes.push({ cols, rows }); }
  async dispose(reason: string): Promise<void> { this.disposed.push(reason); }
  emitOutput(data: string): void { for (const fn of this.outputs) fn(data); }
}

function makeRegistry(provider: TerminalProvider): TerminalProviderRegistry {
  return { list: () => [{ kind: provider.kind, enabled: provider.enabled, reason: provider.reason }], get: (kind) => kind === provider.kind ? provider : undefined };
}

describe("terminal bridge lifecycle", () => {
  it("handles open attach input resize output detach exit", async () => {
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sent: unknown[] = [];
    const conn = bridge.connect((payload) => sent.push(JSON.parse(payload)));
    const streamId = "stream-1";
    const sessionId = "session-1";

    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", streamId, sessionId, { providerKind: "pty", capabilities: ["interactive", "resizable"] })));
    const token = (sent.find((msg) => (msg as { kind?: string }).kind === "status") as { payload?: { reattachToken?: string } })?.payload?.reattachToken;
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("attach", streamId, sessionId, { resume: false, token: token ?? "missing" })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("input", streamId, sessionId, { data: "ls\n", encoding: "utf8" })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("resize", streamId, sessionId, { cols: 100, rows: 30 })));
    session.emitOutput("ok\n");
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("detach", streamId, sessionId, { reason: "idle" })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("exit", streamId, sessionId, { code: 0, signal: null })));

    expect(session.inputs).toEqual(["ls\n"]);
    expect(session.sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(session.disposed).toContain("client_exit");
    expect(sent.some((msg) => ((msg as { kind: string }).kind === "status"))).toBe(true);
    expect(sent.some((msg) => {
      const out = msg as { kind: string; payload: { data?: string } };
      return out.kind === "output" && out.payload.data === "ok\n";
    })).toBe(true);
  });

  it("rejects disabled provider", async () => {
    const provider: TerminalProvider = { kind: "pty", enabled: false, reason: "node-pty unavailable", async openSession() { throw new Error("x"); } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sent: unknown[] = [];
    const conn = bridge.connect((payload) => sent.push(JSON.parse(payload)));

    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", "s", "x", { providerKind: "pty", capabilities: [] })));

    expect(sent.some((msg) => {
      const out = msg as { kind: string; payload: { code?: string } };
      return out.kind === "error" && out.payload.code === "provider_disabled";
    })).toBe(true);
  });

  it("allows reattach from new connection and keeps session alive until cleanup", async () => {
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];
    const connA = bridge.connect((payload) => sentA.push(JSON.parse(payload)));
    const connB = bridge.connect((payload) => sentB.push(JSON.parse(payload)));

    await bridge.handleMessage(connA, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));
    const token = (sentA.find((msg) => (msg as { kind?: string }).kind === "status") as { payload?: { reattachToken?: string } })?.payload?.reattachToken;
    bridge.disconnect(connA);
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("attach", "stream-1", "session-1", { resume: false, token: token ?? "missing" })));
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "session-1", { data: "pwd\n", encoding: "utf8" })));
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("resize", "stream-1", "session-1", { cols: 10, rows: 10 })));

    expect(session.inputs).toEqual(["pwd\n"]);
    expect(session.sizes).toEqual([{ cols: 10, rows: 10 }]);
    expect(session.disposed).toEqual([]);
    expect(sentB.some((msg) => (msg as { kind: string }).kind === "status")).toBe(true);
  });

  it("rejects invalid sessionId on open and mutating paths", async () => {
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sent: unknown[] = [];
    const conn = bridge.connect((payload) => sent.push(JSON.parse(payload)));

    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "", { providerKind: "pty", capabilities: ["interactive"] })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "bad id with spaces", { data: "x", encoding: "utf8" })));

    expect(sent.filter((msg) => {
      const out = msg as { kind: string; payload: { code?: string } };
      return out.kind === "error" && out.payload.code === "invalid_session_id";
    }).length).toBeGreaterThanOrEqual(2);
  });

  it("denies streamId mismatch and duplicate session open", async () => {
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sent: unknown[] = [];
    const conn = bridge.connect((payload) => sent.push(JSON.parse(payload)));

    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("input", "stream-2", "session-1", { data: "bad\n", encoding: "utf8" })));
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));

    expect(sent.some((msg) => (msg as { kind: string; payload: { code?: string } }).kind === "error" && (msg as { payload: { code?: string } }).payload.code === "stream_mismatch")).toBe(true);
    expect(sent.some((msg) => (msg as { kind: string; payload: { code?: string } }).kind === "error" && (msg as { payload: { code?: string } }).payload.code === "duplicate_session")).toBe(true);
  });

  it("denies foreign connection control without ownership", async () => {
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sentA: unknown[] = [];
    const sentB: unknown[] = [];
    const connA = bridge.connect((payload) => sentA.push(JSON.parse(payload)));
    const connB = bridge.connect((payload) => sentB.push(JSON.parse(payload)));

    await bridge.handleMessage(connA, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "session-1", { data: "whoami\n", encoding: "utf8" })));
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("resize", "stream-1", "session-1", { cols: 20, rows: 20 })));
    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("exit", "stream-1", "session-1", { code: 0, signal: null })));

    expect(session.inputs).toEqual([]);
    expect(session.sizes).toEqual([]);
    expect(session.disposed).toEqual([]);
    expect(sentB.filter((msg) => (msg as { kind?: string; payload?: { code?: string } }).kind === "error" && (msg as { payload?: { code?: string } }).payload?.code === "forbidden").length).toBe(3);
    expect((sentA.find((msg) => (msg as { kind?: string }).kind === "status") as { payload?: { reattachToken?: string } })?.payload?.reattachToken).toBeTruthy();
  });

  it("disconnect cleanup disposes unowned session remains protected", async () => {
    vi.useFakeTimers();
    const session = new MockSession();
    const provider: TerminalProvider = { kind: "pty", enabled: true, async openSession() { return session; } };
    const bridge = new TerminalBridge(makeRegistry(provider));
    const sentB: unknown[] = [];
    const connA = bridge.connect(() => {});
    const connB = bridge.connect((payload) => sentB.push(JSON.parse(payload)));

    await bridge.handleMessage(connA, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: ["interactive"] })));
    bridge.disconnect(connA);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.disposed).toContain("disconnect");

    await bridge.handleMessage(connB, JSON.stringify(createTerminalStreamEnvelope("attach", "stream-1", "session-1", { resume: false, token: "nope" })));
    expect(sentB.some((msg) => (msg as { kind?: string; payload?: { code?: string } }).kind === "error" && (msg as { payload?: { code?: string } }).payload?.code === "not_found")).toBe(true);
    vi.useRealTimers();
  });
});
