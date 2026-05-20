import {
  createTerminalStreamEnvelope,
  validateTerminalStreamMessage,
  type TerminalStreamMessage,
} from "../../../../../packages/core/src/terminal/protocol.ts";
import type { TerminalProviderRegistry, TerminalProviderSession } from "./provider-registry.ts";

type Send = (payload: string) => void;
type SessionState = {
  streamId: string;
  session: TerminalProviderSession;
  attached: Set<string>;
  ownerConnectionId: string;
  reattachToken: string;
  seq: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

export class TerminalBridge {
  private readonly sockets = new Map<string, Send>();
  private readonly sessions = new Map<string, SessionState>();
  private nextSocketId = 1;

  constructor(private readonly providers: TerminalProviderRegistry) {}

  connect(send: Send): string {
    const id = `terminal-${this.nextSocketId++}`;
    this.sockets.set(id, send);
    return id;
  }

  disconnect(connectionId: string): void {
    this.sockets.delete(connectionId);
    for (const [sessionId, state] of this.sessions.entries()) {
      state.attached.delete(connectionId);
      if (state.attached.size === 0) {
        if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
        state.cleanupTimer = setTimeout(() => {
          void state.session.dispose("disconnect").finally(() => this.sessions.delete(sessionId));
        }, 30_000);
      }
    }
  }

  async handleMessage(connectionId: string, raw: string): Promise<void> {
    const send = this.sockets.get(connectionId);
    if (!send) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(send, "bridge", "invalid", "invalid_json", "invalid json", true);
      return;
    }

    if (!validateTerminalStreamMessage(parsed)) {
      this.sendError(send, "bridge", "invalid", "invalid_message", "invalid protocol envelope", true);
      return;
    }

    const msg = parsed as TerminalStreamMessage;
    if (!isValidSessionId(msg.sessionId)) {
      this.sendError(send, msg.streamId, msg.sessionId, "invalid_session_id", "invalid session id", true);
      return;
    }
    if (msg.kind === "open") return this.open(connectionId, send, msg);
    if (msg.kind === "attach") return this.attach(connectionId, send, msg.sessionId, msg.streamId, msg.payload.token);
    if (msg.kind === "detach") return this.detach(connectionId, send, msg.sessionId, msg.streamId);
    if (msg.kind === "input") return this.input(connectionId, send, msg.sessionId, msg.streamId, msg.payload.data);
    if (msg.kind === "resize") return this.resize(connectionId, send, msg.sessionId, msg.streamId, msg.payload.cols, msg.payload.rows);
    if (msg.kind === "exit") return this.exit(connectionId, send, msg.sessionId, msg.streamId);

    this.sendError(send, msg.streamId, msg.sessionId, "unsupported", `unsupported message ${msg.kind}`, true);
  }

  private async open(connectionId: string, send: Send, msg: Extract<TerminalStreamMessage, { kind: "open" }>): Promise<void> {
    if (this.sessions.has(msg.sessionId)) {
      this.sendError(send, msg.streamId, msg.sessionId, "duplicate_session", "session already exists", true);
      return;
    }
    const provider = this.providers.get(msg.payload.providerKind);
    if (!provider || !provider.enabled) {
      this.sendError(send, msg.streamId, msg.sessionId, "provider_disabled", provider?.reason ?? "provider disabled", true);
      return;
    }
    try {
      const session = await provider.openSession({ sessionId: msg.sessionId, capabilities: msg.payload.capabilities });
      const state: SessionState = {
        streamId: msg.streamId,
        session,
        attached: new Set([connectionId]),
        ownerConnectionId: connectionId,
        reattachToken: crypto.randomUUID(),
        seq: 0,
        cleanupTimer: null,
      };
      state.session.onOutput((data) => {
        state.seq += 1;
        this.broadcast(msg.sessionId, createTerminalStreamEnvelope("output", state.streamId, msg.sessionId, { data, encoding: "utf8", sequence: state.seq, bytes: Buffer.byteLength(data) }));
      });
      state.session.onExit((code, signal) => {
        this.broadcast(msg.sessionId, createTerminalStreamEnvelope("exit", state.streamId, msg.sessionId, { code, signal }));
        this.sessions.delete(msg.sessionId);
      });
      this.sessions.set(msg.sessionId, state);
      send(JSON.stringify(createTerminalStreamEnvelope("status", msg.streamId, msg.sessionId, { state: "open", attached: true, paused: false, bytesIn: 0, bytesOut: 0, backlogBytes: 0, reattachToken: state.reattachToken })));
    } catch (error) {
      this.sendError(send, msg.streamId, msg.sessionId, "provider_error", error instanceof Error ? error.message : "provider error", true);
    }
  }

  private attach(connectionId: string, send: Send, sessionId: string, streamId: string, token: string | undefined): void {
    const state = this.sessions.get(sessionId);
    if (!state) return this.sendError(send, streamId, sessionId, "not_found", "session not found", true);
    if (state.streamId !== streamId) return this.sendError(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true);
    if (!token || token !== state.reattachToken) return this.sendError(send, streamId, sessionId, "forbidden", "invalid attach token", false);
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }
    state.attached.add(connectionId);
    state.ownerConnectionId = connectionId;
    send(JSON.stringify(createTerminalStreamEnvelope("status", streamId, sessionId, { state: "attached", attached: true, paused: false, bytesIn: 0, bytesOut: 0, backlogBytes: 0, reattachToken: state.reattachToken })));
  }

  private detach(connectionId: string, send: Send, sessionId: string, streamId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return this.sendError(send, streamId, sessionId, "not_found", "session not found", true);
    if (state.streamId !== streamId) return this.sendError(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true);
    if (state.ownerConnectionId !== connectionId) return this.sendError(send, streamId, sessionId, "forbidden", "connection not owner", false);
    state.attached.delete(connectionId);
    if (state.attached.size === 0) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      state.cleanupTimer = setTimeout(() => {
        void state.session.dispose("detach_timeout").finally(() => this.sessions.delete(sessionId));
      }, 30_000);
    }
  }

  private async input(connectionId: string, send: Send, sessionId: string, streamId: string, data: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return this.sendError(send, streamId, sessionId, "not_found", "session not found", true);
    if (state.streamId !== streamId) return this.sendError(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true);
    if (state.ownerConnectionId !== connectionId) return this.sendError(send, streamId, sessionId, "forbidden", "connection not owner", false);
    try {
      await state.session.input(data);
    } catch (error) {
      this.sendError(send, streamId, sessionId, "provider_error", error instanceof Error ? error.message : "provider error", true);
    }
  }

  private async resize(connectionId: string, send: Send, sessionId: string, streamId: string, cols: number, rows: number): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return this.sendError(send, streamId, sessionId, "not_found", "session not found", true);
    if (state.streamId !== streamId) return this.sendError(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true);
    if (state.ownerConnectionId !== connectionId) return this.sendError(send, streamId, sessionId, "forbidden", "connection not owner", false);
    try {
      await state.session.resize(cols, rows);
    } catch (error) {
      this.sendError(send, streamId, sessionId, "provider_error", error instanceof Error ? error.message : "provider error", true);
    }
  }

  private async exit(connectionId: string, send: Send, sessionId: string, streamId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return this.sendError(send, streamId, sessionId, "not_found", "session not found", true);
    if (state.streamId !== streamId) return this.sendError(send, streamId, sessionId, "stream_mismatch", "stream mismatch", true);
    if (state.ownerConnectionId !== connectionId) return this.sendError(send, streamId, sessionId, "forbidden", "connection not owner", false);
    await state.session.dispose("client_exit");
    this.sessions.delete(sessionId);
  }

  private broadcast(sessionId: string, envelope: unknown): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const payload = JSON.stringify(envelope);
    for (const connId of state.attached) this.sockets.get(connId)?.(payload);
  }

  private sendError(send: Send, streamId: string, sessionId: string, code: string, message: string, recoverable: boolean): void {
    send(JSON.stringify(createTerminalStreamEnvelope("error", streamId, sessionId, { code, message, recoverable })));
  }
}

const SESSION_ID_MAX = 128;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

function isValidSessionId(value: string): boolean {
  return value.length > 0 && value.length <= SESSION_ID_MAX && SESSION_ID_RE.test(value);
}
