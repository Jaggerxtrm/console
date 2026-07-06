import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { substrateApi } from "../../../src/dashboard/lib/substrate-api.ts";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ issue: { id: "forge-1" }, ok: true, issueId: "forge-1", projectId: "demo", projects: [], issues: [], memories: [], interactions: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("substrateApi write calls", () => {
  it("routes write calls through /api/substrate with expected methods and headers", async () => {
    await substrateApi.createIssue("owner/repo", { title: "Alpha" }, { adminToken: "secret" });
    await substrateApi.updateIssue("owner/repo", "forge-1", { status: "blocked" }, { adminToken: "secret" });
    await substrateApi.closeIssue("owner/repo", "forge-1", { reason: "done" }, { adminToken: "secret" });
    await substrateApi.reopenIssue("owner/repo", "forge-1", { adminToken: "secret" });
    await substrateApi.deleteIssue("owner/repo", "forge-1", { adminToken: "secret" });

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method, new Headers(init?.headers).get("x-console-write-token")])).toEqual([
      ["/api/substrate/projects/owner%2Frepo/issues", "POST", "secret"],
      ["/api/substrate/projects/owner%2Frepo/issues/forge-1", "PATCH", "secret"],
      ["/api/substrate/projects/owner%2Frepo/issues/forge-1/close", "POST", "secret"],
      ["/api/substrate/projects/owner%2Frepo/issues/forge-1/reopen", "POST", "secret"],
      ["/api/substrate/projects/owner%2Frepo/issues/forge-1", "DELETE", "secret"],
    ]);
  });
});
