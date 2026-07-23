import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient } from "../../../src/dashboard/lib/client.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFetch = any;

function mockFetch(data: unknown, status = 200): void {
  (globalThis as AnyFetch).fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function getMockFetch(): ReturnType<typeof vi.fn> {
  return (globalThis as AnyFetch).fetch as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ApiClient.getEvents", () => {
  it("calls /api/github/events with no params by default", async () => {
    mockFetch({ data: [], limit: 50, offset: 0 });
    const client = new ApiClient("http://localhost");
    await client.getEvents();
    expect(getMockFetch()).toHaveBeenCalledWith("http://localhost/api/github/events");
  });

  it("appends filter params to query string", async () => {
    mockFetch({ data: [], limit: 50, offset: 0 });
    const client = new ApiClient("http://localhost");
    await client.getEvents({ repos: ["owner/repo"], types: ["PushEvent"] });
    const url = getMockFetch().mock.calls[0][0] as string;
    expect(url).toContain("repos=owner%2Frepo");
    expect(url).toContain("types=PushEvent");
  });
});

describe("ApiClient.getRepos", () => {
  it("calls /api/github/repos", async () => {
    mockFetch({ data: [] });
    const client = new ApiClient("http://localhost");
    await client.getRepos();
    expect(getMockFetch()).toHaveBeenCalledWith("http://localhost/api/github/repos");
  });
});

describe("ApiClient.getSummary", () => {
  it("calls /api/github/summary with period param", async () => {
    mockFetch({ events: 0, pushes: 0, prs: 0, commits: 0, repos: 0 });
    const client = new ApiClient("http://localhost");
    await client.getSummary("week");
    expect(getMockFetch()).toHaveBeenCalledWith("http://localhost/api/github/summary?period=week");
  });
});

describe("ApiClient error handling", () => {
  it("throws on non-ok response", async () => {
    mockFetch({}, 500);
    const client = new ApiClient("http://localhost");
    await expect(client.getEvents()).rejects.toThrow("API error 500");
  });
});

describe("ApiClient.addRepo", () => {
  it("POSTs full_name to /api/github/repos", async () => {
    mockFetch({ full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null });
    const client = new ApiClient("http://localhost");
    const repo = await client.addRepo("owner/repo");
    expect(repo.full_name).toBe("owner/repo");
    const call = getMockFetch().mock.calls[0] as [string, RequestInit];
    expect(call[1].method).toBe("POST");
  });
});

describe("ApiClient.getContributions", () => {
  it("calls /api/github/contributions", async () => {
    mockFetch({ data: [] });
    const client = new ApiClient("http://localhost");
    await client.getContributions();
    expect(getMockFetch()).toHaveBeenCalledWith("http://localhost/api/github/contributions");
  });
});
