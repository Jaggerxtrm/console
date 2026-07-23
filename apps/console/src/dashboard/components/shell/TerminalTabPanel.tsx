import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalStream } from "../terminal/TerminalStream.tsx";
import { useShellStore } from "../../stores/shell.ts";
import type { TerminalStreamChunk } from "../terminal/TerminalStream.tsx";

const TERMINAL_WS_PATH = "/api/console/terminal/ws";
const TERMINAL_PROTOCOL_VERSION = "1.0.0";

type TerminalEnvelope =
  | { kind: "status"; sessionId: string; payload: { state: string; attached: boolean; reattachToken?: string } }
  | { kind: "output"; sessionId: string; payload: { data: string } }
  | { kind: "exit"; sessionId: string; payload: { code: number | null; signal: string | null } }
  | { kind: "error"; sessionId: string; payload: { code: string; message: string } };

export function TerminalTabPanel() {
  const sessionId = useShellStore((s) => s.terminalSessionId);
  const output = useShellStore((s) => s.terminalOutput);
  const reattachToken = useShellStore((s) => s.terminalReattachToken);
  const setTerminalSessionId = useShellStore((s) => s.setTerminalSessionId);
  const setTerminalReattachToken = useShellStore((s) => s.setTerminalReattachToken);
  const appendTerminalOutput = useShellStore((s) => s.appendTerminalOutput);
  const resetTerminalOutput = useShellStore((s) => s.resetTerminalOutput);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState("");
  const [needsAdminToken, setNeedsAdminToken] = useState(false);
  const [connectionKey, setConnectionKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const adminTokenRef = useRef("");
  const pendingSessionIdRef = useRef<string | null>(sessionId);
  const reattachTokenRef = useRef<string | null>(reattachToken);

  const socketUrl = useMemo(() => buildTerminalSocketUrl(), []);
  const isProblemState = status === "disconnected" || status === "error" || status.endsWith("_error") || Boolean(error);

  useEffect(() => {
    pendingSessionIdRef.current = sessionId;
    reattachTokenRef.current = reattachToken;
    setError(null);
    setStatus("connecting");

    const abortController = new AbortController();
    let ws: WebSocket | null = null;

    void requestTerminalTicket(adminTokenRef.current, abortController.signal).then(async (response) => {
      if (abortController.signal.aborted) return;
      if (response.status === 403) {
        const reason = await readTicketError(response);
        const adminRequired = reason === "admin-only shell access requires verified admin";
        setNeedsAdminToken(adminRequired);
        setStatus(adminRequired ? "authorization_required" : "error");
        setError(adminRequired ? "admin token required" : reason);
        return;
      }
      if (!response.ok) {
        setStatus("error");
        setError("terminal authorization failed");
        return;
      }

      setNeedsAdminToken(false);
      setError(null);
      const socket = new WebSocket(socketUrl);
      ws = socket;
      wsRef.current = socket;

      socket.onopen = () => {
      const activeSessionId = pendingSessionIdRef.current;
      if (activeSessionId && reattachTokenRef.current) {
        sendTerminalMessage(socket, "attach", activeSessionId, { resume: true, reattachToken: reattachTokenRef.current });
        setStatus("attaching");
        return;
      }
      if (activeSessionId && !reattachTokenRef.current) {
        pendingSessionIdRef.current = null;
        setTerminalSessionId(null);
      }

      const newSessionId = crypto.randomUUID();
      pendingSessionIdRef.current = newSessionId;
      setTerminalSessionId(newSessionId);
      resetTerminalOutput();
      sendTerminalMessage(socket, "open", newSessionId, { providerKind: "pty", capabilities: ["interactive", "resizable"] });
      setStatus("opening");
      };

      socket.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as TerminalEnvelope;
      if (msg.kind === "status") {
        pendingSessionIdRef.current = msg.sessionId;
        if (typeof msg.payload.reattachToken === "string" && msg.payload.reattachToken.length > 0) {
          reattachTokenRef.current = msg.payload.reattachToken;
          setTerminalReattachToken(msg.payload.reattachToken);
        }
        setTerminalSessionId(msg.sessionId);
        setStatus(msg.payload.state);
        setError(null);
        return;
      }
      if (msg.kind === "output") {
        appendTerminalOutput(msg.payload.data);
        return;
      }
      if (msg.kind === "exit") {
        setStatus(msg.payload.code === 0 ? "exited" : "error");
        setTerminalSessionId(null);
        setTerminalReattachToken(null);
        resetTerminalOutput();
        return;
      }
      if (msg.kind === "error") {
        if (msg.payload.code === "not_found" && pendingSessionIdRef.current === msg.sessionId) {
          const newSessionId = crypto.randomUUID();
          pendingSessionIdRef.current = newSessionId;
          reattachTokenRef.current = null;
          setTerminalSessionId(newSessionId);
          setTerminalReattachToken(null);
          resetTerminalOutput();
          sendTerminalMessage(socket, "open", newSessionId, { providerKind: "pty", capabilities: ["interactive", "resizable"] });
          setStatus("opening");
          setError(null);
          return;
        }
        setStatus("error");
        setError(`${msg.payload.code}: ${msg.payload.message}`);
      }
      };

      socket.onerror = () => {
      setStatus("error");
      setError("terminal websocket failed");
      };

      socket.onclose = () => {
      setStatus((current) => current === "exited" ? current : "disconnected");
      };
    }).catch((cause: unknown) => {
      if (abortController.signal.aborted) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "terminal authorization failed");
    });

    return () => {
      abortController.abort();
      ws?.close();
      wsRef.current = null;
    };
  }, [appendTerminalOutput, connectionKey, reattachToken, resetTerminalOutput, setTerminalReattachToken, setTerminalSessionId, socketUrl]);

  const handleInput = useCallback((data: string) => {
    const ws = wsRef.current;
    const activeSessionId = pendingSessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionId) return;
    sendTerminalMessage(ws, "input", activeSessionId, { data, encoding: "utf8" });
  }, []);

  const handleResize = useCallback(({ cols, rows }: { cols: number; rows: number }) => {
    const ws = wsRef.current;
    const activeSessionId = pendingSessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionId) return;
    sendTerminalMessage(ws, "resize", activeSessionId, { cols, rows });
  }, []);

  const handleReconnect = useCallback(() => {
    wsRef.current?.close();
    setError(null);
    setStatus("connecting");
    setConnectionKey((value) => value + 1);
  }, []);

  const handleAdminConnect = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    adminTokenRef.current = adminToken;
    setConnectionKey((value) => value + 1);
  }, [adminToken]);

  const handleClear = useCallback(() => {
    resetTerminalOutput();
  }, [resetTerminalOutput]);

  const shortSessionId = sessionId ? sessionId.slice(0, 8) : "new";

  return (
    <section className="terminal-panel" aria-label="terminal panel">
      <header className="terminal-panel-toolbar">
        <div className="terminal-panel-title">
          <span className={`terminal-panel-dot is-${statusTone(status, error)}`} aria-hidden="true" />
          <span>Terminal</span>
          <span className="terminal-panel-status">{formatStatus(status)}</span>
        </div>
        <div className="terminal-panel-meta">
          <span>{shortSessionId}</span>
          <span>{output.length} chunks</span>
        </div>
        <div className="terminal-panel-actions">
          <button type="button" onClick={handleClear}>clear</button>
          <button type="button" onClick={handleReconnect}>{isProblemState ? "reconnect" : "restart socket"}</button>
        </div>
      </header>
      {error ? <div className="terminal-panel-error" role="alert">{error}</div> : null}
      {needsAdminToken ? (
        <form className="terminal-panel-auth" onSubmit={handleAdminConnect}>
          <label htmlFor="terminal-admin-token">Admin token</label>
          <input
            id="terminal-admin-token"
            type="password"
            value={adminToken}
            autoComplete="off"
            onChange={(event) => setAdminToken(event.target.value)}
          />
          <button type="submit" disabled={!adminToken}>Connect</button>
        </form>
      ) : null}
      <TerminalStream
        className="terminal-panel-stream"
        output={output as readonly TerminalStreamChunk[]}
        onInput={handleInput}
        onResize={handleResize}
        onDetach={() => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN && pendingSessionIdRef.current) {
            sendTerminalMessage(ws, "detach", pendingSessionIdRef.current, { reason: "drawer-close" });
          }
        }}
      />
    </section>
  );
}

function requestTerminalTicket(adminToken: string, signal: AbortSignal): Promise<Response> {
  return fetch("/api/console/terminal/ticket", {
    method: "POST",
    credentials: "same-origin",
    signal,
    ...(adminToken ? { headers: { "x-gitboard-shell-token": adminToken } } : {}),
  });
}

async function readTicketError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.length > 0
      ? body.error
      : "terminal authorization denied";
  } catch {
    return "terminal authorization denied";
  }
}

function sendTerminalMessage<TPayload>(ws: WebSocket, kind: string, sessionId: string, payload: TPayload): void {
  ws.send(JSON.stringify({
    version: TERMINAL_PROTOCOL_VERSION,
    kind,
    streamId: sessionId,
    sessionId,
    timestamp: new Date().toISOString(),
    payload,
  }));
}

function buildTerminalSocketUrl(): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = TERMINAL_WS_PATH;
  return url.toString();
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function statusTone(status: string, error: string | null): "ok" | "warn" | "bad" {
  if (error || status === "error" || status.endsWith("_error") || status === "disconnected") return "bad";
  if (status === "connecting" || status === "opening" || status === "attaching") return "warn";
  return "ok";
}
