const { Window } = await import("happy-dom");
const window = new Window({ url: "http://localhost/" });
globalThis.window = window as unknown as Window & typeof globalThis;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.performance = window.performance;
globalThis.setTimeout = window.setTimeout.bind(window);
globalThis.clearTimeout = window.clearTimeout.bind(window);

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { act, renderHook, waitFor } = await import("@testing-library/react");
import type { WsMessage } from "../../../src/dashboard/lib/ws.ts";
import type { GraphResponse } from "../../../src/types/graph.ts";

const wsHandlerByChannel = new Map<string, (msg: WsMessage) => void>();
const originalFetch = globalThis.fetch;

vi.mock("../../../src/dashboard/hooks/useWebSocket.ts", () => ({
  useWebSocket: (channel: string, handler: (msg: WsMessage) => void) => {
    wsHandlerByChannel.set(channel, handler);
  },
}));

const { useGraphData } = await import("../../../src/dashboard/hooks/useGraphData.ts");

const graph = (id: string): GraphResponse => ({
  project_id: id,
  repo_slug: id,
  generated_at: "2026-05-20T00:00:00.000Z",
  nodes: [],
  edges: [],
  specialists: [],
});

beforeEach(() => {
  wsHandlerByChannel.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useGraphData", () => {
  it("does not refetch fresh cached graph data on focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph("gitboard") });
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => useGraphData("gitboard"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules one refetch for stale empty graph data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard"), freshness: "stale" }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard"), freshness: "stale" }) });
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => useGraphData("gitboard"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => { vi.advanceTimersByTime(1600); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => { vi.advanceTimersByTime(1600); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates and refreshes on beads sync hints for selected project", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => graph("gitboard-sync") }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-sync"), generated_at: "2026-05-20T00:00:01.000Z" }) });
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => useGraphData("gitboard-sync"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(wsHandlerByChannel.get("beads:changes")).toBeTypeOf("function");
    wsHandlerByChannel.get("beads:changes")?.({ type: "event", channel: "beads:changes", event: "beads:sync_hint", data: { project_id: "gitboard-sync" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toContain("refresh=true");
  });
});
