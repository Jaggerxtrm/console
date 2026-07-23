/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../../../src/dashboard/hooks/useWebSocket.ts", () => ({ useWebSocket: vi.fn() }));

import { useChains } from "../../../src/dashboard/hooks/useChains.ts";
import { invalidateDashboardResource } from "../../../src/dashboard/lib/resource.ts";

afterEachHookCleanup();

function afterEachHookCleanup() {
  // no-op placeholder for static analyzers; cleanup done via beforeEach reset.
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  send(_payload: string): void {}
  close(): void {}
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  invalidateDashboardResource("specialists:chains", 0);
  invalidateDashboardResource("specialists:chains:all", 0);
  invalidateDashboardResource("specialists:chains:repo-a", 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
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
        { repoSlug: "specialists", beadId: "standalone", jobId: "job-latest", chainId: null, chainKind: "prep", specialist: "prep", status: "done", updatedAt: "2026-05-20T00:30:00.000Z", last_output: "delta" },
      ],
    }) });

    const { result } = renderHook(() => useChains());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chains).toHaveLength(3);
    expect(result.current.chains[0]?.chainId).toBe("job-latest");
    expect(result.current.chains[1]?.chainId).toBe("chain-2");
    expect(result.current.chains[2]?.chainId).toBe("chain-1");
    expect(result.current.chains[2]?.roles.map((role) => role.role)).toEqual(["executor", "reviewer"]);
    expect(result.current.chains[2]?.lastMessage).toBe("beta");
  });

  it("preserves starting status and filters by repo keys", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      in_flight: [
        { repoSlug: "repo-a", beadId: "a1", jobId: "job-start", chainId: "chain-a", chainKind: "executor", specialist: "executor", status: "starting", updatedAt: "2026-05-20T00:00:00.000Z", last_output: "booting" },
        { repoSlug: "repo-b", beadId: "b1", jobId: "job-run", chainId: "chain-b", chainKind: "executor", specialist: "executor", status: "running", updatedAt: "2026-05-20T00:01:00.000Z", last_output: "running" },
      ],
      recent_history: [],
    }) });

    const { result } = renderHook(() => useChains({ repoKeys: ["repo-a"] }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chains).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/specialists/jobs/in-flight?limit=1000&repo_slug=repo-a");
    expect(result.current.chains[0]?.chainId).toBe("chain-a");
    expect(result.current.chains[0]?.status).toBe("starting");
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
