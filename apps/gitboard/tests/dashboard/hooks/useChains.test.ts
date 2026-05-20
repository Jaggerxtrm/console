/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useChains } from "../../../src/dashboard/hooks/useChains.ts";

afterEachHookCleanup();

function afterEachHookCleanup() {
  // no-op placeholder for static analyzers; cleanup done via beforeEach reset.
}

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useChains", () => {
  it("aggregates chain jobs from in-flight + recent history", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      in_flight: [
        { repoSlug: "gitboard", beadId: "a1", chainId: "chain-1", chainKind: "executor", specialist: "executor", status: "running", updatedAt: "2026-05-20T00:00:00.000Z", last_output: "alpha" },
      ],
      recent_history: [
        { repoSlug: "gitboard", beadId: "a2", chainId: "chain-1", chainKind: "reviewer", specialist: "reviewer", status: "done", updatedAt: "2026-05-20T00:10:00.000Z", last_output: "beta" },
        { repoSlug: "gitboard", beadId: "b1", chainId: "chain-2", chainKind: "executor", specialist: "executor", status: "error", updatedAt: "2026-05-20T00:20:00.000Z", last_output: "gamma" },
      ],
    }) });

    const { result } = renderHook(() => useChains());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chains).toHaveLength(2);
    expect(result.current.chains[0]?.chainId).toBe("chain-2");
    expect(result.current.chains[1]?.chainId).toBe("chain-1");
    expect(result.current.chains[1]?.roles.map((role) => role.role)).toEqual(["executor", "reviewer"]);
    expect(result.current.chains[1]?.lastMessage).toBe("beta");
  });

  it("pauses polling when document hidden", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ in_flight: [], recent_history: [] }) });
    const { unmount } = renderHook(() => useChains());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });
});
