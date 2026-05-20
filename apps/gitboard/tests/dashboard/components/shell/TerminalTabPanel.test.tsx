import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const terminalStreamMock = vi.fn((props: { output?: readonly string[]; status?: string; onInput?: (data: string) => void; onResize?: (size: { cols: number; rows: number }) => void }) => {
  return React.createElement("div", { "data-testid": "terminal-stream", "data-status": props.status ?? "", "data-output": props.output?.join("|") ?? "" });
});

vi.mock("../../../../src/dashboard/components/terminal/TerminalStream.tsx", () => ({
  TerminalStream: (props: unknown) => terminalStreamMock(props as { output?: readonly string[]; status?: string }),
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = WebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = WebSocket.CLOSED; this.onclose?.(); }
  open(): void { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>); }
}

function setupStore() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
  });
}

describe("TerminalTabPanel", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", { location: { origin: "http://localhost:5177" } } as typeof window);
    vi.useFakeTimers();
    setupStore();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("opens new session, keeps session id, and reattaches after remount", async () => {
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");

    const { unmount } = render(React.createElement(TerminalTabPanel));
    const first = FakeWebSocket.instances[0];
    first.open();
    first.message({ kind: "status", sessionId: "session-1", payload: { state: "open", attached: true, note: "token-1" } });
    first.message({ kind: "output", sessionId: "session-1", payload: { data: "echo\n" } });

    expect(useShellStore.getState().terminalSessionId).toBe("session-1");
    expect(useShellStore.getState().terminalOutput).toEqual(["echo\n"]);

    unmount();

    render(React.createElement(TerminalTabPanel));
    const second = FakeWebSocket.instances[1];
    second.open();

    const attach = second.sent.map((msg) => JSON.parse(msg)).find((msg) => msg.kind === "attach");
    expect(attach?.payload?.token).toBe("token-1");
    expect(terminalStreamMock).toHaveBeenCalled();
  });

  it("sends resize and input over websocket", async () => {
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setTerminalSessionId("session-2");

    render(React.createElement(TerminalTabPanel));
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const props = terminalStreamMock.mock.calls.at(-1)?.[0] as { onInput?: (data: string) => void; onResize?: (size: { cols: number; rows: number }) => void };
    props.onInput?.("ls\n");
    props.onResize?.({ cols: 120, rows: 40 });

    expect(ws.sent.some((msg) => JSON.parse(msg).kind === "input")).toBe(true);
    expect(ws.sent.some((msg) => JSON.parse(msg).kind === "resize")).toBe(true);
  });
});
