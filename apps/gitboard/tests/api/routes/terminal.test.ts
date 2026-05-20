import { describe, expect, it } from "vitest";
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
  emitExit(code: number | null, signal: string | null): void { for (const fn of this.exits) fn(code, signal); }
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
    await bridge.handleMessage(conn, JSON.stringify(createTerminalStreamEnvelope("attach", streamId, sessionId, { resume: false })));
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
});
