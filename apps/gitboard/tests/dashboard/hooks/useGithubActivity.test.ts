/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGithubStore } from "../../../src/dashboard/stores/github.ts";

const useWebSocketMock = vi.fn();

vi.mock("../../../src/dashboard/lib/client.ts", () => ({
  apiClient: {
    getEvents: vi.fn(async () => ({ data: [], limit: 50, offset: 0 })),
    getRepos: vi.fn(async () => ({ data: [] })),
    getContributions: vi.fn(async () => ({ data: [] })),
    getSummary: vi.fn(async () => ({ count: 0 })),
    getRepoStats: vi.fn(async () => ({ data: [] })),
    getPrs: vi.fn(async () => ({ data: [] })),
    getIssues: vi.fn(async () => ({ data: [] })),
    getReleases: vi.fn(async () => ({ releases: [] })),
  },
}));

vi.mock("../../../src/dashboard/hooks/useWebSocket.ts", () => ({
  useWebSocket: (channel: string, handler: (msg: { event?: string; data?: unknown }) => void) => {
    useWebSocketMock(channel, handler);
  },
}));

import { useGithubActivity } from "../../../src/dashboard/hooks/useGithubActivity.ts";
import { apiClient } from "../../../src/dashboard/lib/client.ts";

beforeEach(() => {
  useGithubStore.setState({ events: [], selectedEvent: null, selectedEventCommits: [], repos: [], contributions: [], summary: null, filter: {}, loading: false, error: null, repoStats: {}, unreadRepos: new Set(), prs: [], issues: [], releases: [] });
  useWebSocketMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGithubActivity", () => {
  it("loads core activity shell data without PR, issue, or release fan-out", async () => {
    vi.mocked(apiClient.getEvents).mockResolvedValueOnce({ data: [], limit: 50, offset: 0 });

    renderHook(() => useGithubActivity({ includeLists: false }));

    await waitFor(() => expect(apiClient.getEvents).toHaveBeenCalled());
    expect(apiClient.getRepos).toHaveBeenCalledTimes(1);
    expect(apiClient.getContributions).toHaveBeenCalledTimes(1);
    expect(apiClient.getSummary).toHaveBeenCalledWith("today");
    expect(apiClient.getRepoStats).toHaveBeenCalledTimes(1);
    expect(apiClient.getPrs).not.toHaveBeenCalled();
    expect(apiClient.getIssues).not.toHaveBeenCalled();
    expect(apiClient.getReleases).not.toHaveBeenCalled();
  });

  it("reloads on github sync hint envelope without repos field", async () => {
    vi.mocked(apiClient.getEvents).mockResolvedValueOnce({ data: [], limit: 50, offset: 0 });
    renderHook(() => useGithubActivity());

    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;
    vi.mocked(apiClient.getRepos).mockClear();

    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 12, boot_id: "x" } });
    });

    await waitFor(() => expect(apiClient.getRepos).toHaveBeenCalledTimes(1));
  });
});
