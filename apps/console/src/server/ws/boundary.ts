import { isShellWebSocketPath } from "../../../../../packages/core/src/terminal/policy.ts";
import type { createConsoleTerminal } from "../terminal/runtime.ts";
import type { createConsoleRealtime, ConsoleWebSocketData } from "./realtime.ts";

type RealtimeRuntime = ReturnType<typeof createConsoleRealtime>;
type TerminalRuntime = ReturnType<typeof createConsoleTerminal>;

export function createConsoleWebSocketBoundary(options: {
  readonly realtime: RealtimeRuntime;
  readonly terminal: TerminalRuntime;
}) {
  function handleUpgrade(
    request: Request,
    server: Bun.Server<ConsoleWebSocketData>,
    peerAddress?: string,
  ): Response | undefined {
    const path = new URL(request.url).pathname;
    return isShellWebSocketPath(path)
      ? options.terminal.handleUpgrade(request, server, peerAddress)
      : options.realtime.handleUpgrade(request, server, peerAddress);
  }

  const websocket: Bun.WebSocketHandler<ConsoleWebSocketData> = {
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    open(ws) {
      if (isTerminalSocket(ws.data)) options.terminal.websocket.open?.(ws);
      else options.realtime.websocket.open?.(ws);
    },
    message(ws, message) {
      if (isTerminalSocket(ws.data)) options.terminal.websocket.message(ws, message);
      else options.realtime.websocket.message(ws, message);
    },
    close(ws, code, reason) {
      if (isTerminalSocket(ws.data)) options.terminal.websocket.close?.(ws, code, reason);
      else options.realtime.websocket.close?.(ws, code, reason);
    },
  };

  return { handleUpgrade, websocket };
}

function isTerminalSocket(data: ConsoleWebSocketData | undefined): boolean {
  return isShellWebSocketPath(data?.path ?? "");
}
