/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpecialistOwnership } from "../../../src/dashboard/hooks/useSpecialistOwnership.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSpecialistOwnership", () => {
  it("polls visible bead ownership so already-mounted cards pick up new specialist runs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ jobId: "8193dc", specialist: "executor", status: "running", repoSlug: "gitboard" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSpecialistOwnership("forge-lqyc.3"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(result.current).toEqual({ role: "executor", state: "running", repoSlug: "gitboard", jobId: "8193dc" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/specialists/jobs?bead_id=forge-lqyc.3");
  });

  it("ignores stale responses after beadId changes", async () => {
    vi.useRealTimers();
    let resolveFirst: (value: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [{ jobId: "new-job", specialist: "reviewer", status: "running", repoSlug: "gitboard" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ beadId }) => useSpecialistOwnership(beadId), { initialProps: { beadId: "old-bead" } });

    rerender({ beadId: "new-bead" });
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current).toEqual({ role: "reviewer", state: "running", repoSlug: "gitboard", jobId: "new-job" }));

    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ jobs: [{ jobId: "old-job", specialist: "executor", status: "running", repoSlug: "gitboard" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
    });

    expect(result.current).toEqual({ role: "reviewer", state: "running", repoSlug: "gitboard", jobId: "new-job" });
  });
});
