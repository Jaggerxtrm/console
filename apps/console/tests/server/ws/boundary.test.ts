import { describe, expect, it, vi } from "vitest";
import { createHostLogger } from "../../../src/server/log.ts";
import { createConsoleTerminal } from "../../../src/server/terminal/runtime.ts";
import { createConsoleRealtime } from "../../../src/server/ws/realtime.ts";
import { createConsoleWebSocketBoundary } from "../../../src/server/ws/boundary.ts";

describe("Console combined WebSocket boundary", () => {
  it("routes terminal paths to the terminal adapter and all others to realtime", () => {
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const realtime = createConsoleRealtime({ logger });
    const terminal = createConsoleTerminal({ logger, env: { NODE_ENV: "production" } as NodeJS.ProcessEnv });
    const boundary = createConsoleWebSocketBoundary({ realtime, terminal });
    const terminalUpgrade = vi.spyOn(terminal, "handleUpgrade").mockReturnValue(new Response("terminal", { status: 403 }));
    const realtimeUpgrade = vi.spyOn(realtime, "handleUpgrade").mockReturnValue(new Response("realtime", { status: 403 }));
    const server = { upgrade: vi.fn() };

    const terminalResponse = boundary.handleUpgrade(new Request("http://localhost/api/console/terminal/ws"), server as never, "127.0.0.1");
    const realtimeResponses = [
      "/api/console/ws",
      "/api/console/shell/status",
      "/api/console/shell-evil",
      "/api/console/terminal/ws-evil",
    ].map((path) => boundary.handleUpgrade(new Request(`http://localhost${path}`), server as never, "127.0.0.1"));

    expect((terminalResponse as Response).status).toBe(403);
    expect(realtimeResponses.every((response) => (response as Response).status === 403)).toBe(true);
    expect(terminalUpgrade).toHaveBeenCalledOnce();
    expect(realtimeUpgrade).toHaveBeenCalledTimes(4);
  });
});
