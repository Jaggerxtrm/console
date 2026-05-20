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
  const [connectionKey, setConnectionKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingSessionIdRef = useRef<string | null>(sessionId);
  const reattachTokenRef = useRef<string | null>(reattachToken);

  const socketUrl = useMemo(() => buildTerminalSocketUrl(), []);
  const isProblemState = status === "disconnected" || status === "error" || status.endsWith("_error") || Boolean(error);

  useEffect(() => {
    pendingSessionIdRef.current = sessionId;
    reattachTokenRef.current = reattachToken;
    setError(null);
    setStatus("connecting");

    const ws = new WebSocket(socketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const activeSessionId = pendingSessionIdRef.current;
      if (activeSessionId && reattachTokenRef.current) {
        sendTerminalMessage(ws, "attach", activeSessionId, { resume: true, reattachToken: reattachTokenRef.current });
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
      sendTerminalMessage(ws, "open", newSessionId, { providerKind: "pty", capabilities: ["interactive", "resizable"] });
      setStatus("opening");
    };

    ws.onmessage = (event) => {
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
          sendTerminalMessage(ws, "open", newSessionId, { providerKind: "pty", capabilities: ["interactive", "resizable"] });
          setStatus("opening");
          setError(null);
          return;
        }
        setStatus("error");
        setError(`${msg.payload.code}: ${msg.payload.message}`);
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setError("terminal websocket failed");
    };

    ws.onclose = () => {
      setStatus((current) => current === "exited" ? current : "disconnected");
    };

    return () => {
      ws.close();
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
