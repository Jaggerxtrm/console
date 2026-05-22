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
const { act, renderHook, waitFor } = await import("@testing-library/react");
import { useGithubStore } from "../../../src/dashboard/stores/github.ts";

const useWebSocketMock = vi.fn();

vi.mock("../../../src/dashboard/lib/client.ts", () => ({
  apiClient: {
    getEvents: vi.fn(async () => ({ data: [], limit: 50, offset: 0 })),
    getRepos: vi.fn(async () => ({ data: [] })),
    getContributions: vi.fn(async () => ({ data: [] })),
    getSummary: vi.fn(async () => ({ count: 0 })),
    getRepoStats: vi.fn(async () => ({ data: [] })),
    getPrs: vi.fn(async () => ({ data: [], limit: 0, offset: 0 })),
    getIssues: vi.fn(async () => ({ data: [], limit: 0, offset: 0 })),
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

type MockedApiMethod = {
  mockResolvedValue: (value: unknown) => MockedApiMethod;
  mockResolvedValueOnce: (value: unknown) => MockedApiMethod;
  mockRejectedValue: (value: unknown) => MockedApiMethod;
  mockReturnValue: (value: unknown) => MockedApiMethod;
  mockReturnValueOnce: (value: unknown) => MockedApiMethod;
};

function mockedApi(method: unknown): MockedApiMethod {
  return method as MockedApiMethod;
}

beforeEach(() => {
  useGithubStore.setState({ events: [], selectedEvent: null, selectedEventCommits: [], repos: [], contributions: [], summary: null, filter: {}, loading: false, error: null, repoStats: {}, unreadRepos: new Set(), prs: [], issues: [], releases: [] });
  useWebSocketMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGithubActivity", () => {
  it("loads core activity shell data without PR, issue, or release fan-out", async () => {
    mockedApi(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });

    renderHook(() => useGithubActivity({ includeLists: false }));

    await waitFor(() => expect(apiClient.getEvents).toHaveBeenCalled());
    expect(apiClient.getRepos).toHaveBeenCalled();
    expect(apiClient.getContributions).toHaveBeenCalledTimes(1);
    expect(apiClient.getSummary).toHaveBeenCalledWith("today");
    expect(apiClient.getRepoStats).toHaveBeenCalledTimes(1);
    expect(apiClient.getPrs).not.toHaveBeenCalled();
    expect(apiClient.getIssues).not.toHaveBeenCalled();
    expect(apiClient.getReleases).not.toHaveBeenCalled();
  });

  it("applies github websocket PR, issue, and release upserts immediately", async () => {
    mockedApi(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });
    renderHook(() => useGithubActivity({ includeLists: false }));

    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    act(() => {
      handler({ event: "github:pr.upsert", data: { repo: "owner/repo", number: 1, title: "WS PR", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:00:00Z", merged_at: null, closed_at: null } });
      handler({ event: "github:issue.upsert", data: { repo: "owner/repo", number: 2, title: "WS Issue", body: null, state: "open", author: "bob", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T12:01:00Z", closed_at: null } });
      handler({ event: "github:release.upsert", data: { id: "rel-1", repo_full_name: "owner/repo", tag_name: "v1.0.0", name: "One", body: null, html_url: "https://github.com/owner/repo/releases/tag/v1.0.0", author_login: "alice", published_at: "2026-05-20T12:02:00Z" } });
    });

    expect(useGithubStore.getState().prs.map((pr) => pr.title)).toEqual(["WS PR"]);
    expect(useGithubStore.getState().issues.map((issue) => issue.title)).toEqual(["WS Issue"]);
    expect(useGithubStore.getState().releases.map((release) => release.tag_name)).toEqual(["v1.0.0"]);
    expect(useGithubStore.getState().unreadRepos.has("owner/repo")).toBe(true);
  });

  it("refreshes on github sync hint without clearing visible lists first", async () => {
    mockedApi(apiClient.getEvents).mockResolvedValue({ data: [], limit: 50, offset: 0 });
    mockedApi(apiClient.getRepos).mockResolvedValue({ data: [{ full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null }] } as never);
    mockedApi(apiClient.getPrs).mockResolvedValue({ data: [], limit: 0, offset: 0 } as never);
    mockedApi(apiClient.getIssues).mockResolvedValue({ data: [], limit: 0, offset: 0 } as never);

    useGithubStore.setState({ prs: [{ repo: "owner/repo", number: 9, title: "visible PR", body: null, state: "open", author: "carol", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T09:00:00Z", updated_at: "2026-05-20T09:00:00Z", merged_at: null, closed_at: null } as never], issues: [{ repo: "owner/repo", number: 10, title: "visible Issue", body: null, state: "open", author: "dave", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T09:00:00Z", updated_at: "2026-05-20T09:00:00Z", closed_at: null } as never], loading: false, error: "old error" });

    renderHook(() => useGithubActivity());

    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");

    const repoCallsBeforeSync = (apiClient.getRepos as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 12, boot_id: "x" } });
    });

    await waitFor(() => expect((apiClient.getRepos as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(repoCallsBeforeSync));
    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");
  });

  it("keeps rows and reports error when sync hint refresh fails", async () => {
    mockedApi(apiClient.getEvents).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getRepos).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getContributions).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getSummary).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getRepoStats).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getPrs).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getIssues).mockRejectedValue(new Error("network error"));
    mockedApi(apiClient.getReleases).mockRejectedValue(new Error("network error"));

    useGithubStore.setState({
      events: [{ id: "event-1" } as never],
      repos: [{ full_name: "owner/repo" } as never],
      contributions: [{ date: "2026-05-20", count: 1 } as never],
      summary: { events: 1, pushes: 1, prs: 0, commits: 0, repos: 1 } as never,
      prs: [{ repo: "owner/repo", number: 1, title: "visible PR" } as never],
      issues: [{ repo: "owner/repo", number: 2, title: "visible Issue" } as never],
      loading: false,
      error: null,
    });

    renderHook(() => useGithubActivity());
    await waitFor(() => expect(apiClient.getRepos).toHaveBeenCalled());
    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 42, boot_id: "boot-x" } });
    });

    expect(useGithubStore.getState().events).toHaveLength(1);
    expect(useGithubStore.getState().repos).toHaveLength(1);
    expect(useGithubStore.getState().contributions).toHaveLength(1);
    expect(useGithubStore.getState().summary?.events).toBe(1);
    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");
    expect(useGithubStore.getState().error).toBe("network error");
  });

  it("keeps rows visible and loading false while preserveVisibleState refresh is pending", async () => {
    let resolveEvents: ((value: { data: never[]; limit: number; offset: number }) => void) | null = null;
    const pendingEvents = new Promise<{ data: never[]; limit: number; offset: number }>((resolve) => {
      resolveEvents = resolve;
    });

    mockedApi(apiClient.getEvents)
      .mockResolvedValueOnce({ data: [{ id: "event-1" }], limit: 50, offset: 0 })
      .mockReturnValue(pendingEvents);
    mockedApi(apiClient.getRepos).mockResolvedValue({ data: [{ full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null }] } as never);
    mockedApi(apiClient.getContributions).mockResolvedValue({ data: [{ date: "2026-05-20", count: 1 }] } as never);
    mockedApi(apiClient.getSummary).mockResolvedValue({ events: 1, pushes: 1, prs: 0, commits: 0, repos: 1 } as never);
    mockedApi(apiClient.getRepoStats).mockResolvedValue({ data: [] } as never);
    mockedApi(apiClient.getPrs)
      .mockResolvedValueOnce({ data: [{ repo: "owner/repo", number: 1, title: "visible PR", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T10:00:00Z", merged_at: null, closed_at: null }], limit: 0, offset: 0 } as never)
      .mockResolvedValue({ data: [{ repo: "owner/repo", number: 1, title: "pending PR", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T10:00:00Z", merged_at: null, closed_at: null }], limit: 0, offset: 0 } as never);
    mockedApi(apiClient.getIssues)
      .mockResolvedValueOnce({ data: [{ repo: "owner/repo", number: 2, title: "visible Issue", body: null, state: "open", author: "bob", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T10:00:00Z", closed_at: null }], limit: 0, offset: 0 } as never)
      .mockResolvedValue({ data: [{ repo: "owner/repo", number: 2, title: "pending Issue", body: null, state: "open", author: "bob", url: null, comment_count: 0, label_names: null, created_at: "2026-05-20T10:00:00Z", updated_at: "2026-05-20T10:00:00Z", closed_at: null }], limit: 0, offset: 0 } as never);
    mockedApi(apiClient.getReleases).mockResolvedValue({ releases: [] });

    useGithubStore.setState({
      events: [{ id: "event-1" } as never],
      repos: [{ full_name: "owner/repo" } as never],
      contributions: [{ date: "2026-05-20", count: 1 } as never],
      summary: { events: 1, pushes: 1, prs: 0, commits: 0, repos: 1 } as never,
      prs: [{ repo: "owner/repo", number: 1, title: "visible PR" } as never],
      issues: [{ repo: "owner/repo", number: 2, title: "visible Issue" } as never],
      loading: false,
      error: null,
    });

    renderHook(() => useGithubActivity());
    await waitFor(() => expect(apiClient.getRepos).toHaveBeenCalled());
    await waitFor(() => expect(useWebSocketMock).toHaveBeenCalled());
    const handler = useWebSocketMock.mock.calls[0][1] as (msg: { event?: string; data?: unknown }) => void;

    const repoCallsBeforeSync = (apiClient.getRepos as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await act(async () => {
      handler({ event: "github:sync_hint", data: { reason: "buffer_miss", since_seq: 99, boot_id: "boot-y" } });
    });

    expect(useGithubStore.getState().loading).toBe(false);
    expect(useGithubStore.getState().events[0]?.id).toBe("event-1");
    expect(useGithubStore.getState().prs[0]?.title).toBe("visible PR");
    expect(useGithubStore.getState().issues[0]?.title).toBe("visible Issue");

    const completeEvents = resolveEvents as ((value: { data: never[]; limit: number; offset: number }) => void) | null;
    if (completeEvents) completeEvents({ data: [], limit: 50, offset: 0 });
    await waitFor(() => expect((apiClient.getRepos as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(repoCallsBeforeSync));
    expect(useGithubStore.getState().loading).toBe(false);
  });
});
