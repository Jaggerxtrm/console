import {
  createTerminalStreamEnvelope,
  validateTerminalStreamMessage,
  type TerminalStreamMessage,
} from "../../../../../packages/core/src/terminal/protocol.ts";
import type {
  TerminalProviderRegistry,
  TerminalProviderSession,
} from "../../../../../packages/core/src/terminal/provider-registry.ts";

type Send = (payload: string) => void;
type AuthContext = { isVerifiedAdmin?: boolean };
type WebSocketUpgradeServer = { upgrade(req: Request, options?: unknown): boolean };

type SessionState = {
  streamId: string;
  providerKind: string;
  session: TerminalProviderSession;
  attached: Set<string>;
  ownerConnectionId: string;
  reattachToken: string;
  seq: number;
  openedAt: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

export interface TerminalBridgeEvent {
  readonly event: "client.connected" | "client.disconnected" | "session.open" | "session.close" | "session.cleanup" | "request.denied";
  readonly outcome: "success" | "denied" | "error" | "cleanup";
  readonly connectionId?: string;
  readonly providerKind?: string;
  readonly code?: string;
  readonly duration_ms?: number;
}

export interface TerminalBridgeOptions {
  readonly cleanupDelayMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: TerminalBridgeEvent) => void;
}

export class TerminalBridge {
  private pendingConnectIds: string[] = [];
  private readonly sockets = new Map<string, Send>();
  private readonly authContexts = new Map<string, AuthContext>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly cleanupDelayMs: number;
  private readonly now: () => number;
  private nextSocketId = 1;

  constructor(
    private readonly providers: TerminalProviderRegistry,
    private readonly options: TerminalBridgeOptions = {},
  ) {
    this.cleanupDelayMs = options.cleanupDelayMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  connect(send: Send, connectionId?: string, authContext?: AuthContext): string {
    const id = connectionId ?? this.pendingConnectIds.shift() ?? `terminal-${this.nextSocketId++}`;
    if (connectionId) this.pendingConnectIds = this.pendingConnectIds.filter((pendingId) => pendingId !== connectionId);
    this.sockets.set(id, send);
    if (authContext) this.authContexts.set(id, authContext);
    this.emit({ event: "client.connected", outcome: "success", connectionId: id });
    return id;
  }

  handleUpgrade(req: Request, server: WebSocketUpgradeServer, path: string, authContext: AuthContext = {}): Response | undefined {
    const id = `terminal-${this.nextSocketId++}`;
    this.pendingConnectIds.push(id);
    this.authContexts.set(id, authContext);
    const upgraded = server.upgrade(req, { data: { path, connId: id } });
    if (upgraded) return undefined;
    this.pendingConnectIds = this.pendingConnectIds.filter((pendingId) => pendingId !== id);
    this.authContexts.delete(id);
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  disconnect(connectionId: string): void {
    this.sockets.delete(connectionId);
    this.authContexts.delete(connectionId);
    this.emit({ event: "client.disconnected", outcome: "success", connectionId });
    for (const [sessionId, state] of this.sessions) {
      state.attached.delete(connectionId);
      if (state.attached.size === 0) this.scheduleCleanup(sessionId, state, "disconnect");
    }
  }

  async handleMessage(connectionId: string, raw: string): Promise<void> {
    const send = this.sockets.get(connectionId);
    if (!send) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.deny(send, "bridge", "invalid", "invalid_json", "invalid json", true, connectionId);
      return;
    }
    if (!validateTerminalStreamMessage(parsed)) {
      this.deny(send, "bridge", "invalid", "invalid_message", "invalid protocol envelope", true, connectionId);
      return;
    }

    const msg = parsed as TerminalStreamMessage;
    if (!isValidSessionId(msg.sessionId)) {
      this.deny(send, msg.streamId, "invalid", "invalid_session_id", "invalid session id", true, connectionId);
      return;
    }
    if (msg.kind === "open") return this.open(connectionId, send, msg);
    if (msg.kind === "attach") return this.attach(connectionId, send, msg.sessionId, msg.streamId, msg.payload.reattachToken);
    if (msg.kind === "detach") return this.detach(connectionId, send, msg.sessionId, msg.streamId);
    if (msg.kind === "input") return this.input(connectionId, send, msg.sessionId, msg.streamId, msg.payload.data);
    if (msg.kind === "resize") return this.resize(connectionId, send, msg.sessionId, msg.streamId, msg.payload.cols, msg.payload.rows);
    if (msg.kind === "exit") return this.exit(connectionId, send, msg.sessionId, msg.streamId);
    this.deny(send, msg.streamId, msg.sessionId, "unsupported", "unsupported message", true, connectionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  async stop(): Promise<void> {
    const disposals = [...this.sessions.entries()].map(async ([sessionId, state]) => {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      try {
        await state.session.dispose("shutdown");
      } finally {
        this.finalizeSession(sessionId, state, "cleanup", "shutdown");
      }
    });
    await Promise.allSettled(disposals);
    this.sessions.clear();
    this.sockets.clear();
    this.authContexts.clear();
    this.pendingConnectIds = [];
  }

  private async open(connectionId: string, send: Send, msg: Extract<TerminalStreamMessage, { kind: "open" }>): Promise<void> {
    if (this.sessions.has(msg.sessionId)) {
      this.deny(send, msg.streamId, msg.sessionId, "duplicate_session", "session already exists", true, connectionId, msg.payload.providerKind);
      return;
    }
    const provider = this.providers.get(msg.payload.providerKind, this.authContexts.get(connectionId));
    if (!provider?.enabled) {
      this.deny(send, msg.streamId, msg.sessionId, "provider_disabled", provider?.reason ?? "provider disabled", true, connectionId, provider?.kind);
      return;
    }

    const startedAt = this.now();
    try {
      const session = await provider.openSession({
        sessionId: msg.sessionId,
        capabilities: msg.payload.capabilities,
        jobId: msg.payload.jobId,
        cwd: msg.payload.cwd,
      });
      const state: SessionState = {
        streamId: msg.streamId,
        providerKind: provider.kind,
        session,
        attached: new Set([connectionId]),
        ownerConnectionId: connectionId,
        reattachToken: crypto.randomUUID(),
        seq: 0,
        openedAt: startedAt,
        cleanupTimer: null,
        closed: false,
      };
      session.onOutput((data) => {
        state.seq += 1;
        this.broadcast(msg.sessionId, createTerminalStreamEnvelope("output", state.streamId, msg.sessionId, {
          data,
          encoding: "utf8",
          sequence: state.seq,
          bytes: Buffer.byteLength(data),
        }));
      });
      session.onExit((code, signal) => {
        this.broadcast(msg.sessionId, createTerminalStreamEnvelope("exit", state.streamId, msg.sessionId, { code, signal }));
        this.finalizeSession(msg.sessionId, state, "success", "provider_exit");
      });
      this.sessions.set(msg.sessionId, state);
      send(JSON.stringify(createTerminalStreamEnvelope("status", msg.streamId, msg.sessionId, {
        state: "open",
        attached: true,
        paused: false,
        bytesIn: 0,
        bytesOut: 0,
        backlogBytes: 0,
        reattachToken: state.reattachToken,
      })));
      this.emit({
        event: "session.open",
        outcome: "success",
        connectionId,
        providerKind: state.providerKind,
        duration_ms: this.now() - startedAt,
      });
    } catch {
      this.deny(send, msg.streamId, msg.sessionId, "provider_error", "provider rejected request", true, connectionId, provider.kind);
    }
  }

  private attach(connectionId: string, send: Send, sessionId: string, streamId: string, reattachToken: string | undefined): void {
    const state = this.sessions.get(sessionId);
    if (!state) return this.deny(send, streamId, sessionId, "not_found", "session not found", true, connectionId);
    if (state.streamId !== streamId) return this.deny(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true, connectionId);
    if (state.providerKind === "specialist-feed" && this.authContexts.get(connectionId)?.isVerifiedAdmin !== true) {
      return this.deny(send, streamId, sessionId, "forbidden", "verified admin required for specialist feed", false, connectionId, state.providerKind);
    }
    if (!reattachToken || reattachToken !== state.reattachToken) {
      return this.deny(send, streamId, sessionId, "forbidden", "invalid attach token", false, connectionId, state.providerKind);
    }
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    state.attached.add(connectionId);
    state.ownerConnectionId = connectionId;
    send(JSON.stringify(createTerminalStreamEnvelope("status", streamId, sessionId, {
      state: "attached",
      attached: true,
      paused: false,
      bytesIn: 0,
      bytesOut: 0,
      backlogBytes: 0,
      reattachToken: state.reattachToken,
    })));
  }

  private detach(connectionId: string, send: Send, sessionId: string, streamId: string): void {
    const state = this.ownedState(connectionId, send, sessionId, streamId);
    if (!state) return;
    state.attached.delete(connectionId);
    if (state.attached.size === 0) this.scheduleCleanup(sessionId, state, "detach_timeout");
  }

  private async input(connectionId: string, send: Send, sessionId: string, streamId: string, data: string): Promise<void> {
    const state = this.ownedState(connectionId, send, sessionId, streamId);
    if (!state) return;
    try {
      await state.session.input(data);
    } catch {
      this.deny(send, streamId, sessionId, "provider_error", "provider rejected input", true, connectionId, state.providerKind);
    }
  }

  private async resize(connectionId: string, send: Send, sessionId: string, streamId: string, cols: number, rows: number): Promise<void> {
    const state = this.ownedState(connectionId, send, sessionId, streamId);
    if (!state) return;
    try {
      await state.session.resize(cols, rows);
    } catch {
      this.deny(send, streamId, sessionId, "provider_error", "provider rejected resize", true, connectionId, state.providerKind);
    }
  }

  private async exit(connectionId: string, send: Send, sessionId: string, streamId: string): Promise<void> {
    const state = this.ownedState(connectionId, send, sessionId, streamId);
    if (!state) return;
    try {
      await state.session.dispose("client_exit");
    } finally {
      this.finalizeSession(sessionId, state, "success", "client_exit");
    }
  }

  private ownedState(connectionId: string, send: Send, sessionId: string, streamId: string): SessionState | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      this.deny(send, streamId, sessionId, "not_found", "session not found", true, connectionId);
      return null;
    }
    if (state.streamId !== streamId) {
      this.deny(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true, connectionId, state.providerKind);
      return null;
    }
    if (state.ownerConnectionId !== connectionId) {
      this.deny(send, streamId, sessionId, "forbidden", "connection not owner", false, connectionId, state.providerKind);
      return null;
    }
    return state;
  }

  private scheduleCleanup(sessionId: string, state: SessionState, reason: string): void {
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(() => {
      void state.session.dispose(reason).finally(() => {
        this.finalizeSession(sessionId, state, "cleanup", reason);
      });
    }, this.cleanupDelayMs);
  }

  private broadcast(sessionId: string, envelope: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const payload = JSON.stringify(envelope);
    for (const connectionId of state.attached) this.sockets.get(connectionId)?.(payload);
  }

  private deny(
    send: Send,
    streamId: string,
    sessionId: string,
    code: string,
    message: string,
    recoverable: boolean,
    connectionId: string,
    providerKind?: string,
  ): void {
    send(JSON.stringify(createTerminalStreamEnvelope("error", streamId, sessionId, { code, message, recoverable })));
    this.emit({ event: "request.denied", outcome: "denied", connectionId, providerKind, code });
  }

  private emitClose(state: SessionState, outcome: "success" | "cleanup", code: string): void {
    this.emit({
      event: outcome === "cleanup" ? "session.cleanup" : "session.close",
      outcome,
      providerKind: state.providerKind,
      code,
      duration_ms: this.now() - state.openedAt,
    });
  }

  private finalizeSession(
    sessionId: string,
    state: SessionState,
    outcome: "success" | "cleanup",
    code: string,
  ): void {
    if (state.closed) return;
    state.closed = true;
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    if (this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
    this.emitClose(state, outcome, code);
  }

  private emit(event: TerminalBridgeEvent): void {
    this.options.onEvent?.(event);
  }
}

const SESSION_ID_MAX = 128;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

function isValidSessionId(value: string): boolean {
  return value.length > 0 && value.length <= SESSION_ID_MAX && SESSION_ID_RE.test(value);
}
