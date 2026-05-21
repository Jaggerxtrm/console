/** @vitest-environment happy-dom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsMessage } from "../../../src/dashboard/lib/ws.ts";
import type { GraphResponse } from "../../../src/types/graph.ts";

let wsHandler: ((msg: WsMessage) => void) | null = null;

vi.mock("../../../src/dashboard/hooks/useWebSocket.ts", () => ({
  useWebSocket: (_channel: string, handler: (msg: WsMessage) => void) => {
    wsHandler = handler;
  },
}));

import { useGraphData } from "../../../src/dashboard/hooks/useGraphData.ts";

const graph = (id: string): GraphResponse => ({
  project_id: id,
  repo_slug: id,
  generated_at: "2026-05-20T00:00:00.000Z",
  nodes: [],
  edges: [],
  specialists: [],
});

beforeEach(() => {
  wsHandler = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useGraphData", () => {
  it("does not refetch fresh cached graph data on focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph("gitboard") });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useGraphData("gitboard"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules one refetch for stale empty graph data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard"), freshness: "stale" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard"), freshness: "stale" }) });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useGraphData("gitboard"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates and refreshes on beads sync hints for the selected project", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => graph("gitboard-sync") })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...graph("gitboard-sync"), generated_at: "2026-05-20T00:00:01.000Z" }) });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useGraphData("gitboard-sync"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(wsHandler).toBeTypeOf("function");

    act(() => {
      wsHandler?.({ type: "event", channel: "beads:changes", event: "beads:sync_hint", data: { project_id: "gitboard-sync" } });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toContain("refresh=true");
  });
});
