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
    vi.mocked(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });

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

  it("applies github websocket PR and issue upserts immediately", async () => {
    vi.mocked(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });
    renderHook(() => useGithubActivity({ includeLists: false }));

    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    act(() => {
      handler({ event: "github:pr.upsert", data: { repo: "owner/repo", number: 1, title: "WS PR", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:00:00Z", merged_at: null, closed_at: null } });
      handler({ event: "github:issue.upsert", data: { repo: "owner/repo", number: 2, title: "WS Issue", body: null, state: "open", author: "bob", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:01:00Z", closed_at: null } });
    });

    expect(useGithubStore.getState().prs.map((pr) => pr.title)).toEqual(["WS PR"]);
    expect(useGithubStore.getState().issues.map((issue) => issue.title)).toEqual(["WS Issue"]);
    expect(useGithubStore.getState().unreadRepos.has("owner/repo")).toBe(true);
  });

  it("refreshes on github sync hint without clearing visible lists first", async () => {
    vi.mocked(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });
    vi.mocked(apiClient.getRepos).mockResolvedValue({ data: [{ full_name: "owner/repo" }] });
    vi.mocked(apiClient.getPrs).mockResolvedValue({ data: [{ repo: "owner/repo", number: 1, title: "stale PR", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:00:00Z", merged_at: null, closed_at: null }] });
    vi.mocked(apiClient.getIssues).mockResolvedValue({ data: [{ repo: "owner/repo", number: 2, title: "stale Issue", body: null, state: "open", author: "bob", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:01:00Z", closed_at: null }] });

    useGithubStore.setState({ prs: [{ repo: "owner/repo", number: 9, title: "visible PR", body: null, state: "open", author: "carol", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T09:00:00Z", updated_at: "2026-05-20T09:00:00Z", merged_at: null, closed_at: null }], issues: [{ repo: "owner/repo", number: 10, title: "visible Issue", body: null, state: "open", author: "dave", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T09:00:00Z", updated_at: "2026-05-20T09:00:00Z", closed_at: null }], loading: false, error: "old error" });

    renderHook(() => useGithubActivity());

    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");

    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 12, boot_id: "x" } });
    });

    await waitFor(() => expect(apiClient.getRepos).toHaveBeenCalledTimes(1));
    expect(useGithubStore.getState().prs[0]?.title).toBe("stale PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("stale Issue");
  });

  it("keeps rows and reports error when sync hint refresh fails", async () => {
    vi.mocked(apiClient.getEvents).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getRepos).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getContributions).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getSummary).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getRepoStats).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getPrs).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getIssues).mockRejectedValue(new Error("network error"));
    vi.mocked(apiClient.getReleases).mockRejectedValue(new Error("network error"));

    useGithubStore.setState({
      events: [{ id: "event-1" } as never],
      repos: [{ full_name: "owner/repo" } as never],
      contributions: [{ day: "2026-05-20", count: 1 } as never],
      summary: { count: 1 } as never,
      prs: [{ repo: "owner/repo", number: 1, title: "visible PR" } as never],
      issues: [{ repo: "owner/repo", number: 2, title: "visible Issue" } as never],
      loading: false,
      error: null,
    });

    renderHook(() => useGithubActivity());
    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 42, boot_id: "boot-x" } });
    });

    expect(useGithubStore.getState().events).toHaveLength(1);
    expect(useGithubStore.getState().repos).toHaveLength(1);
    expect(useGithubStore.getState().contributions).toHaveLength(1);
    expect(useGithubStore.getState().summary?.count).toBe(1);
    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");
    expect(useGithubStore.getState().error).toBe("network error");
  });

  it("keeps rows visible and loading false while preserveVisibleState refresh is pending", async () => {
    let resolveEvents: ((value: { data: never[]; limit: number; offset: number }) => void) | null = null;
    const pendingEvents = new Promise<{ data: never[]; limit: number; offset: number }>((resolve) => {
      resolveEvents = resolve;
    });

    vi.mocked(apiClient.getEvents).mockReturnValue(pendingEvents);
    vi.mocked(apiClient.getRepos).mockResolvedValue({ data: [{ full_name: "owner/repo" }] });
    vi.mocked(apiClient.getContributions).mockResolvedValue({ data: [{ day: "2026-05-20", count: 1 }] });
    vi.mocked(apiClient.getSummary).mockResolvedValue({ count: 1 });
    vi.mocked(apiClient.getRepoStats).mockResolvedValue({ data: [] });
    vi.mocked(apiClient.getPrs).mockResolvedValue({ data: [{ repo: "owner/repo", number: 1, title: "pending PR" }] });
    vi.mocked(apiClient.getIssues).mockResolvedValue({ data: [{ repo: "owner/repo", number: 2, title: "pending Issue" }] });
    vi.mocked(apiClient.getReleases).mockResolvedValue({ releases: [] });

    useGithubStore.setState({
      events: [{ id: "event-1" } as never],
      repos: [{ full_name: "owner/repo" } as never],
      contributions: [{ day: "2026-05-20", count: 1 } as never],
      summary: { count: 1 } as never,
      prs: [{ repo: "owner/repo", number: 1, title: "visible PR" } as never],
      issues: [{ repo: "owner/repo", number: 2, title: "visible Issue" } as never],
      loading: false,
      error: null,
    });

    renderHook(() => useGithubActivity());
    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 99, boot_id: "boot-y" } });
    });

    expect(useGithubStore.getState().loading).toBe(false);
    expect(useGithubStore.getState().events[0]?.id).toBe("event-1");
    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");

    resolveEvents?.({ data: [], limit: 50, offset: 0 });
    await waitFor(() => expect(apiClient.getRepos).toHaveBeenCalledTimes(1));
    expect(useGithubStore.getState().loading).toBe(false);
  });
});
