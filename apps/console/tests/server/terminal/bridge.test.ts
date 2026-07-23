import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalStreamEnvelope } from "../../../../../packages/core/src/terminal/protocol.ts";
import type {
  TerminalProvider,
  TerminalProviderRegistry,
  TerminalProviderSession,
} from "../../../../../packages/core/src/terminal/provider-registry.ts";
import { TerminalBridge } from "../../../src/server/terminal/bridge.ts";

function makeSession(): TerminalProviderSession {
  return {
    onOutput: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

class RecordingSession implements TerminalProviderSession {
  readonly inputs: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  readonly disposals: string[] = [];
  private readonly outputListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.push(listener);
    return () => {};
  }

  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    this.exitListeners.push(listener);
    return () => {};
  }

  async input(data: string): Promise<void> { this.inputs.push(data); }
  async resize(cols: number, rows: number): Promise<void> { this.sizes.push([cols, rows]); }
  async dispose(reason: string): Promise<void> { this.disposals.push(reason); }
  emitOutput(data: string): void { this.outputListeners.forEach((listener) => listener(data)); }
  emitExit(code: number | null, signal: string | null): void { this.exitListeners.forEach((listener) => listener(code, signal)); }
}

function makeRegistry(provider: TerminalProvider): TerminalProviderRegistry {
  return {
    list: () => [{ kind: provider.kind, enabled: provider.enabled, reason: provider.reason }],
    get: (kind) => kind === provider.kind ? provider : undefined,
  };
}

afterEach(() => vi.useRealTimers());

describe("Console TerminalBridge", () => {
  it("keeps non-admin opens disabled and logs no raw terminal payload", async () => {
    const session = makeSession();
    const events: unknown[] = [];
    const providers: TerminalProviderRegistry = {
      list: () => [],
      get: (_kind, context) => context?.isVerifiedAdmin
        ? { kind: "pty", enabled: true, openSession: async () => session }
        : { kind: "pty", enabled: false, reason: "verified admin required", openSession: async () => session },
    };
    const bridge = new TerminalBridge(providers, { onEvent: (event) => events.push(event) });
    const sent: unknown[] = [];
    const secretSessionId = "token-shaped-session-secret";
    const secretProviderKind = "token-shaped-provider-secret";
    const connectionId = bridge.connect((payload) => sent.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: false });

    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", secretSessionId, {
      providerKind: secretProviderKind,
      capabilities: ["interactive"],
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", secretSessionId, {
      providerKind: "pty",
      capabilities: ["interactive"],
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", secretSessionId, {
      data: "terminal-secret-input",
      encoding: "utf8",
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("resize", "stream-1", secretSessionId, {
      cols: 80,
      rows: 24,
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("exit", "stream-1", secretSessionId, {
      code: 0,
      signal: null,
    })));

    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "invalid_message" }) }),
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "provider_disabled" }) }),
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "not_found" }) }),
    ]));
    expect(session.input).not.toHaveBeenCalled();
    expect(session.resize).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("terminal-secret-input");
    expect(JSON.stringify(events)).not.toContain(secretSessionId);
    expect(JSON.stringify(events)).not.toContain(secretProviderKind);
    expect(bridge.sessionCount()).toBe(0);
  });

  it("preserves failed upgrade status and body without retaining auth state", async () => {
    const bridge = new TerminalBridge({ list: () => [], get: () => undefined });
    const response = bridge.handleUpgrade(
      new Request("http://localhost/api/console/terminal/ws"),
      { upgrade: () => false },
      "/api/console/terminal/ws",
      { isVerifiedAdmin: true },
    );

    expect(response?.status).toBe(400);
    await expect(response?.text()).resolves.toBe("WebSocket upgrade failed");
    expect(bridge.connectionCount()).toBe(0);
  });

  it("passes cwd to an admin provider and drains active sessions on stop", async () => {
    const session = makeSession();
    const openSession = vi.fn(async () => session);
    const providers: TerminalProviderRegistry = {
      list: () => [],
      get: () => ({ kind: "pty", enabled: true, openSession }),
    };
    const bridge = new TerminalBridge(providers);
    const sent: unknown[] = [];
    const connectionId = bridge.connect((payload) => sent.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });

    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", {
      providerKind: "pty",
      capabilities: ["interactive", "resizable"],
      cwd: "allowed",
    })));

    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", cwd: "allowed" }));
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "status" })]));
    await bridge.stop();
    expect(session.dispose).toHaveBeenCalledWith("shutdown");
    expect(bridge.sessionCount()).toBe(0);
    expect(bridge.connectionCount()).toBe(0);
  });

  it("preserves open, input, resize, output, and client exit envelopes", async () => {
    const session = new RecordingSession();
    const bridge = new TerminalBridge(makeRegistry({ kind: "pty", enabled: true, openSession: async () => session }));
    const sent: Array<Record<string, any>> = [];
    const connectionId = bridge.connect((payload) => sent.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });

    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", {
      providerKind: "pty",
      capabilities: ["interactive", "resizable"],
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "session-1", {
      data: "echo ok\n",
      encoding: "utf8",
    })));
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("resize", "stream-1", "session-1", {
      cols: 100,
      rows: 30,
    })));
    session.emitOutput("ok\n");
    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("exit", "stream-1", "session-1", {
      code: 0,
      signal: null,
    })));

    expect(session.inputs).toEqual(["echo ok\n"]);
    expect(session.sizes).toEqual([[100, 30]]);
    expect(session.disposals).toEqual(["client_exit"]);
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "status", payload: expect.objectContaining({ state: "open" }) }),
      expect.objectContaining({ kind: "output", payload: expect.objectContaining({ data: "ok\n", sequence: 1 }) }),
    ]));
  });

  it("reattaches only with the token and transfers session ownership", async () => {
    const session = new RecordingSession();
    const bridge = new TerminalBridge(makeRegistry({ kind: "pty", enabled: true, openSession: async () => session }));
    const sentA: Array<Record<string, any>> = [];
    const sentB: Array<Record<string, any>> = [];
    const connectionA = bridge.connect((payload) => sentA.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });
    const connectionB = bridge.connect((payload) => sentB.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });

    await bridge.handleMessage(connectionA, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", {
      providerKind: "pty",
      capabilities: ["interactive"],
    })));
    const token = sentA.find((message) => message.kind === "status")?.payload?.reattachToken as string;
    bridge.disconnect(connectionA);
    await bridge.handleMessage(connectionB, JSON.stringify(createTerminalStreamEnvelope("attach", "stream-1", "session-1", {
      resume: true,
      reattachToken: "wrong-token",
    })));
    await bridge.handleMessage(connectionB, JSON.stringify(createTerminalStreamEnvelope("attach", "stream-1", "session-1", {
      resume: true,
      reattachToken: token,
    })));
    await bridge.handleMessage(connectionB, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "session-1", {
      data: "pwd\n",
      encoding: "utf8",
    })));

    expect(sentB).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "forbidden" }) }),
      expect.objectContaining({ kind: "status", payload: expect.objectContaining({ state: "attached" }) }),
    ]));
    expect(session.inputs).toEqual(["pwd\n"]);
  });

  it("denies foreign control, stream mismatch, duplicate opens, and invalid ids", async () => {
    const session = new RecordingSession();
    const bridge = new TerminalBridge(makeRegistry({ kind: "pty", enabled: true, openSession: async () => session }));
    const ownerMessages: Array<Record<string, any>> = [];
    const foreignMessages: Array<Record<string, any>> = [];
    const owner = bridge.connect((payload) => ownerMessages.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });
    const foreign = bridge.connect((payload) => foreignMessages.push(JSON.parse(payload)), undefined, { isVerifiedAdmin: true });

    await bridge.handleMessage(owner, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: [] })));
    await bridge.handleMessage(owner, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", { providerKind: "pty", capabilities: [] })));
    await bridge.handleMessage(owner, JSON.stringify(createTerminalStreamEnvelope("input", "other-stream", "session-1", { data: "x", encoding: "utf8" })));
    await bridge.handleMessage(foreign, JSON.stringify(createTerminalStreamEnvelope("input", "stream-1", "session-1", { data: "secret", encoding: "utf8" })));
    await bridge.handleMessage(foreign, JSON.stringify(createTerminalStreamEnvelope("resize", "stream-1", "bad id", { cols: 80, rows: 24 })));

    expect(ownerMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "duplicate_session" }) }),
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "stream_mismatch" }) }),
    ]));
    expect(foreignMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "forbidden" }) }),
      expect.objectContaining({ kind: "error", payload: expect.objectContaining({ code: "invalid_session_id" }) }),
    ]));
    expect(session.inputs).toEqual([]);
  });

  it("cleans detached sessions after the configured grace period", async () => {
    vi.useFakeTimers();
    const session = new RecordingSession();
    const events: Array<Record<string, any>> = [];
    const bridge = new TerminalBridge(
      makeRegistry({ kind: "pty", enabled: true, openSession: async () => session }),
      { cleanupDelayMs: 100, onEvent: (event) => events.push(event) },
    );
    const connectionId = bridge.connect(() => {}, undefined, { isVerifiedAdmin: true });

    await bridge.handleMessage(connectionId, JSON.stringify(createTerminalStreamEnvelope("open", "stream-1", "session-1", {
      providerKind: "pty",
      capabilities: [],
    })));
    bridge.disconnect(connectionId);
    await vi.advanceTimersByTimeAsync(100);

    expect(session.disposals).toEqual(["disconnect"]);
    expect(bridge.sessionCount()).toBe(0);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "session.cleanup", code: "disconnect", duration_ms: expect.any(Number) }),
    ]));
  });
});
