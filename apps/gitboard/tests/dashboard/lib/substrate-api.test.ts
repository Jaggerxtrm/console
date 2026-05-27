import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { substrateApi } from "../../../src/dashboard/lib/beads.ts";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ projects: [], issues: [], memories: [], interactions: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("substrateApi", () => {
  it("routes list calls through /api/substrate", async () => {
    await substrateApi.listProjects();
    await substrateApi.listIssues("owner/repo", { status: ["open"], limit: 5 });
    await substrateApi.listClosedIssues("owner/repo", 10);
    await substrateApi.listMemories("owner/repo");
    await substrateApi.listInteractions("owner/repo", "forge-1");

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "/api/substrate/projects",
      "/api/substrate/projects/owner%2Frepo/issues?status=open&limit=5",
      "/api/substrate/projects/owner%2Frepo/issues/closed?limit=10",
      "/api/substrate/projects/owner%2Frepo/memories",
      "/api/substrate/projects/owner%2Frepo/interactions?issue_id=forge-1",
    ]);
  });
});
