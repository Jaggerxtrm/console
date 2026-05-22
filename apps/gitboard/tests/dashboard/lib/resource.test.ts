const { Window } = await import("happy-dom");
const windowStub = new Window({ url: "http://localhost/" });
globalThis.Event = windowStub.Event;
globalThis.window = windowStub as unknown as Window & typeof globalThis;
globalThis.document = windowStub.document;
globalThis.navigator = windowStub.navigator;
globalThis.HTMLElement = windowStub.HTMLElement;
globalThis.CustomEvent = windowStub.CustomEvent;
globalThis.performance = windowStub.performance;
globalThis.setTimeout = windowStub.setTimeout.bind(windowStub);
globalThis.clearTimeout = windowStub.clearTimeout.bind(windowStub);

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { act, renderHook, waitFor } = await import("@testing-library/react");
const { applyDashboardResourceDelta, invalidateDashboardResource, useDashboardResource } = await import("../../../src/dashboard/lib/resource.ts");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

const makePayload = (value: string) => ({ value });

describe("useDashboardResource", () => {
  it("keeps last successful data after fetch error", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(makePayload("alpha")).mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useDashboardResource({ key: "resource-last-success", cacheTtlMs: 10_000, fetcher: async () => fetcher() }));
    await waitFor(() => expect(result.current.data).toEqual(makePayload("alpha")));
    await act(async () => { await result.current.refresh({ force: true, refresh: true }); });
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.data).toEqual(makePayload("alpha"));
  });

  it("coalesces repeated invalidations into one refetch", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(makePayload("alpha"));
    renderHook(() => useDashboardResource({ key: "resource-invalidate", cacheTtlMs: 10_000, fetcher: async () => fetcher() }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    invalidateDashboardResource("resource-invalidate");
    invalidateDashboardResource("resource-invalidate");
    act(() => { vi.advanceTimersByTime(1500); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("checks cache on focus without forcing a fresh cached resource", async () => {
    const fetcher = vi.fn().mockResolvedValue(makePayload("alpha"));
    renderHook(() => useDashboardResource({ key: "resource-focus", cacheTtlMs: 10_000, fetcher: async () => fetcher() }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("supports forced refresh", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(makePayload("alpha")).mockResolvedValueOnce(makePayload("beta"));
    const { result } = renderHook(() => useDashboardResource({ key: "resource-force", cacheTtlMs: 10_000, fetcher: async () => fetcher() }));
    await waitFor(() => expect(result.current.data).toEqual(makePayload("alpha")));
    await act(async () => { await result.current.refresh({ force: true, refresh: true }); });
    await waitFor(() => expect(result.current.data).toEqual(makePayload("beta")));
  });

  it("polls while visible", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(makePayload("alpha"));
    renderHook(() => useDashboardResource({ key: "resource-poll", cacheTtlMs: 10_000, pollMs: 100, fetcher: async () => fetcher() }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("applies ws delta without refetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(makePayload("alpha"));
    renderHook(() => useDashboardResource({ key: "resource-delta", cacheTtlMs: 10_000, fetcher: async () => fetcher() }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const updated = applyDashboardResourceDelta<{ value: string }>("resource-delta", (current) => ({ ...current, value: "beta" }));
    expect(updated).toEqual(makePayload("beta"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries once for stale empty data", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce({ value: "" }).mockResolvedValueOnce({ value: "filled" });
    renderHook(() => useDashboardResource({ key: "resource-stale", cacheTtlMs: 10_000, staleEmptyRetryMs: 100, isEmpty: (data) => data.value === "", fetcher: async () => fetcher() }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => { vi.advanceTimersByTime(100); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
