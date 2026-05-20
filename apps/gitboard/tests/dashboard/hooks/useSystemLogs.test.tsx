/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSystemLogs } from "../../../src/dashboard/hooks/useSystemLogs.ts";
import type { WsMessage } from "../../../src/dashboard/lib/ws.ts";

let wsHandler: ((msg: WsMessage) => void) | null = null;

vi.mock("../../../src/dashboard/hooks/useWebSocket.ts", () => ({
  useWebSocket: (_channel: string, handler: (msg: WsMessage) => void) => {
    wsHandler = handler;
  },
}));

beforeEach(() => {
  wsHandler = null;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSystemLogs", () => {
  it("loads existing ring logs before streaming live entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { ts: "2026-05-20T00:00:00.000Z", level: "info", component: "api", event: "request.slow", data: { ms: 501 } },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { result } = renderHook(() => useSystemLogs());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries.map((entry) => entry.event)).toEqual(["request.slow"]);

    act(() => {
      wsHandler?.({
        type: "event",
        channel: "system",
        event: "system:log",
        data: { ts: "2026-05-20T00:00:01.000Z", level: "warn", component: "watcher", event: "drift.detected", data: { projectId: "repo" } },
      });
    });

    expect(result.current.entries.map((entry) => entry.event)).toEqual(["request.slow", "drift.detected"]);
  });

  it("filters loaded logs client-side", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { ts: "1", level: "info", component: "api", event: "request.slow", data: { ms: 501 } },
      { ts: "2", level: "error", component: "poller", event: "error", msg: "poll loop failed" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } })));

    const { result } = renderHook(() => useSystemLogs({ level: "error" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].event).toBe("error");
  });

  it("preserves streamed logs that arrive while reload is in flight", async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    const { result } = renderHook(() => useSystemLogs());

    act(() => {
      wsHandler?.({
        type: "event",
        channel: "system",
        event: "system:log",
        data: { ts: "2026-05-20T00:00:02.000Z", level: "warn", component: "watcher", event: "streamed", data: { projectId: "repo" } },
      });
    });
    expect(result.current.entries.map((entry) => entry.event)).toEqual(["streamed"]);

    await act(async () => {
      resolveFetch(new Response(JSON.stringify([
        { ts: "2026-05-20T00:00:01.000Z", level: "info", component: "api", event: "snapshot" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries.map((entry) => entry.event)).toEqual(["snapshot", "streamed"]);
  });
});
