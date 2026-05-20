import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalStream } from "../terminal/TerminalStream.tsx";
import { useShellStore } from "../../stores/shell.ts";
import type { TerminalStreamChunk } from "../terminal/TerminalStream.tsx";

const TERMINAL_WS_PATH = "/api/console/terminal/ws";

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
  const [status, setStatus] = useState("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const pendingSessionIdRef = useRef<string | null>(sessionId);
  const reattachTokenRef = useRef<string | null>(reattachToken);

  const socketUrl = useMemo(() => buildTerminalSocketUrl(), []);

  useEffect(() => {
    pendingSessionIdRef.current = sessionId;
    reattachTokenRef.current = reattachToken;
    const ws = new WebSocket(socketUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const activeSessionId = pendingSessionIdRef.current;
      if (activeSessionId && reattachTokenRef.current) {
        ws.send(JSON.stringify({ kind: "attach", streamId: activeSessionId, sessionId: activeSessionId, payload: { resume: true, reattachToken: reattachTokenRef.current } }));
        setStatus("attached");
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
      ws.send(JSON.stringify({ kind: "open", streamId: newSessionId, sessionId: newSessionId, payload: { providerKind: "pty", capabilities: ["interactive", "resizable"] } }));
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
        return;
      }
      if (msg.kind === "output") {
        appendTerminalOutput(msg.payload.data);
        return;
      }
      if (msg.kind === "exit") {
        setStatus(msg.payload.code === 0 ? "exit" : "error");
        setTerminalSessionId(null);
        setTerminalReattachToken(null);
        resetTerminalOutput();
        return;
      }
      if (msg.kind === "error") {
        setStatus(msg.payload.code);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [appendTerminalOutput, reattachToken, resetTerminalOutput, setTerminalReattachToken, setTerminalSessionId, socketUrl]);

  const handleInput = (data: string) => {
    const ws = wsRef.current;
    const activeSessionId = pendingSessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionId) return;
    ws.send(JSON.stringify({ kind: "input", streamId: activeSessionId, sessionId: activeSessionId, payload: { data, encoding: "utf8" } }));
  };

  const handleResize = ({ cols, rows }: { cols: number; rows: number }) => {
    const ws = wsRef.current;
    const activeSessionId = pendingSessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionId) return;
    ws.send(JSON.stringify({ kind: "resize", streamId: activeSessionId, sessionId: activeSessionId, payload: { cols, rows } }));
  };

  return (
    <TerminalStream
      output={output as readonly TerminalStreamChunk[]}
      status={status}
      onInput={handleInput}
      onResize={handleResize}
      onDetach={() => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && pendingSessionIdRef.current) {
          ws.send(JSON.stringify({ kind: "detach", streamId: pendingSessionIdRef.current, sessionId: pendingSessionIdRef.current, payload: { reason: "drawer-close" } }));
        }
      }}
    />
  );
}

function buildTerminalSocketUrl(): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = TERMINAL_WS_PATH;
  return url.toString();
}
