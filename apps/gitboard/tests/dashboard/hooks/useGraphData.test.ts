const { Window } = await import("happy-dom");
const windowStub = new Window({ url: "http://localhost/" });
(globalThis as any).Event = windowStub.Event;
(globalThis as any).window = windowStub as any;
(globalThis as any).document = windowStub.document as any;
(globalThis as any).navigator = windowStub.navigator as any;
(globalThis as any).HTMLElement = windowStub.HTMLElement as any;
(globalThis as any).CustomEvent = windowStub.CustomEvent as any;
(globalThis as any).performance = windowStub.performance as any;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
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
  (globalThis as any).fetch = originalFetch as any;
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  (globalThis as any).fetch = originalFetch as any;
});

describe("useGraphData", () => {

  it("ignores beads sync hints without a matching project id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph("gitboard-ignore-2") });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-ignore-2"));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    wsHandlerByChannel.get("beads:changes")?.({ type: "event", channel: "beads:changes", event: "beads:sync_hint", data: { reason: "global" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refetch fresh cached graph data on focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph("gitboard-focus") });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-focus"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new windowStub.Event("focus") as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules one refetch for stale empty graph data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-stale"), freshness: "stale" }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-stale"), freshness: "stale" }) });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-stale"));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(750); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1600); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates and refreshes on beads sync hints for selected project", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => graph("gitboard-sync") }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-sync"), generated_at: "2026-05-20T00:00:01.000Z" }) });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-sync"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(wsHandlerByChannel.get("beads:changes")).toBeTypeOf("function");
    wsHandlerByChannel.get("beads:changes")?.({ type: "event", channel: "beads:changes", event: "beads:sync_hint", data: { project_id: "gitboard-sync" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).not.toContain("refresh=true");
  });});
