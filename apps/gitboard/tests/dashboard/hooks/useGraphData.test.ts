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
const { invalidateDashboardResource } = await import("../../../src/dashboard/lib/resource.ts");

const graph = (id: string): GraphResponse => ({
  project_id: id,
  repo_slug: id,
  generated_at: "2026-05-20T00:00:00.000Z",
  freshness: "fresh",
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
  try {
    vi.clearAllTimers();
  } catch {
    // Some tests never switch to fake timers.
  }
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
    expect(fetchMock.mock.calls[0][0]).toBe("/api/console/graph?project_id=gitboard-ignore-2&include_closed=true");
    wsHandlerByChannel.get("substrate:changes")?.({ type: "event", channel: "substrate:changes", event: "substrate:sync_hint", data: { reason: "global" } });
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
  });

  it("invalidates and refreshes selected project graph data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => graph("gitboard-sync") }).mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-sync"), generated_at: "2026-05-20T00:00:01.000Z" }) });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-sync"));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => invalidateDashboardResource("graph:gitboard-sync", 0));
    await act(async () => { vi.advanceTimersByTime(0); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).not.toContain("refresh=true");
    expect(fetchMock.mock.calls[1][0]).toContain("include_closed=true");
  });

  it("refreshes when materializer sync hint names the selected project", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => graph("gitboard-materialized") })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-materialized"), generated_at: "2026-05-20T00:00:01.000Z" }) });
    (globalThis as any).fetch = fetchMock as any;
    renderHook(() => useGraphData("gitboard-materialized"));
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      wsHandlerByChannel.get("substrate:changes")?.({
        type: "event",
        channel: "substrate:changes",
        event: "substrate:sync_hint",
        data: { source_key: "beads:gitboard-materialized", projectId: "gitboard-materialized", project_id: "gitboard-materialized" },
      });
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("project_id=gitboard-materialized");
  });
});
