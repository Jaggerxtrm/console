import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const terminalStreamMock = vi.fn((props: { output?: readonly string[] }) => (
  React.createElement("div", { "data-testid": "terminal-stream", "data-output": props.output?.join("|") ?? "" })
));

vi.mock("../../../../src/dashboard/components/terminal/TerminalStream.tsx", () => ({
  TerminalStream: (props: unknown) => terminalStreamMock(props as { output?: readonly string[] }),
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) { FakeWebSocket.instances.push(this); }
  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>); }
}

describe("Console TerminalTabPanel browser authentication", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("obtains a same-origin cookie ticket before opening the websocket", async () => {
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    render(React.createElement(TerminalTabPanel));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith("/api/console/terminal/ticket", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers).toBeUndefined();
    const expectedUrl = new URL(window.location.origin);
    expectedUrl.protocol = expectedUrl.protocol === "https:" ? "wss:" : "ws:";
    expectedUrl.pathname = "/api/console/terminal/ws";
    expect(FakeWebSocket.instances[0]?.url).toBe(expectedUrl.toString());
  });

  it("keeps the admin token in memory and sends it only to the ticket endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "admin-only shell access requires verified admin" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    render(React.createElement(TerminalTabPanel));

    const input = await screen.findByLabelText("Admin token");
    fireEvent.change(input, { target: { value: "browser-admin-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "x-gitboard-shell-token": "browser-admin-secret" });
    expect(FakeWebSocket.instances[0]?.url).not.toContain("browser-admin-secret");
  });

  it("does not present an admin prompt when the provider policy is disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "shell provider disabled by default" }),
      { status: 403 },
    )));
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    render(React.createElement(TerminalTabPanel));

    expect(await screen.findByRole("alert")).toHaveTextContent("shell provider disabled by default");
    expect(screen.queryByLabelText("Admin token")).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("preserves session open and reattach envelopes after ticket authentication", async () => {
    const { TerminalTabPanel } = await import("../../../../src/dashboard/components/shell/TerminalTabPanel.tsx");
    const { useShellStore } = await import("../../../../src/dashboard/stores/shell.ts");
    useShellStore.getState().setTerminalSessionId("session-1");
    useShellStore.getState().setTerminalReattachToken("reattach-1");
    render(React.createElement(TerminalTabPanel));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());

    const attach = FakeWebSocket.instances[0]!.sent.map((message) => JSON.parse(message)).find((message) => message.kind === "attach");
    expect(attach.payload.reattachToken).toBe("reattach-1");
  });
});
