import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../src/core/store.ts";
import { GithubPoller } from "../../src/core/github-poller.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { getIssues, getPrs } from "../../src/core/github-store.ts";

const repo = "owner/repo";

function mockResponse(body: unknown, init: ResponseInit = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "1000", "X-RateLimit-Limit": "5000", ...headers },
  });
}

describe("GithubPoller loop", () => {
  let db: ReturnType<typeof createDatabase>;
  let tmpDir: string;
  let fetchSpy: unknown;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-forge-poller-loop-"));
    db = createDatabase(join(tmpDir, "state.db"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("polls repo prs/issues and publishes upserts", async () => {
    const registry = new ChannelRegistry();
    const events: unknown[] = [];
    registry.subscribe("github:activity", { id: "t1", send: (msg) => events.push(msg) });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/issues")) {
        return mockResponse([{ number: 1, title: "Issue", body: null, state: "open", user: { login: "alice" }, html_url: "u", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T10:01:00Z", closed_at: null }]);
      }
      if (url.includes("/pulls")) {
        return mockResponse([{ number: 2, title: "PR", body: null, state: "open", merged_at: null, closed_at: null, user: { login: "bob" }, html_url: "u2", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T10:02:00Z" }]);
      }
      return mockResponse([], { status: 404 });
    });

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token", { registry });
    await poller.pollRepos();

    expect(getIssues(db, { repo })).toHaveLength(1);
    expect(getPrs(db, { repo })).toHaveLength(1);
    expect(events.some((msg) => JSON.stringify(msg).includes("github:issue.upsert"))).toBe(true);
    expect(events.some((msg) => JSON.stringify(msg).includes("github:pr.upsert"))).toBe(true);
    expect(fetchSpy as { toHaveBeenCalled: () => void }).toHaveBeenCalled();
  });

  it("skips parse on 304", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304, headers: { "X-RateLimit-Remaining": "1000", "X-RateLimit-Limit": "5000" } }));
    const poller = new GithubPoller(db, "token");
    const result = await (poller as unknown as { apiGet<T>(path: string, repo?: string, endpoint?: string): Promise<T | null> }).apiGet<{ ok: boolean }>("/repos/owner/repo/issues?state=all&since=1970-01-01T00:00:00Z&per_page=100", repo, "issues");
    expect(result).toBeNull();
  });

  it("pauses when remaining budget low", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      return mockResponse([], {}, { "X-RateLimit-Remaining": "499", "X-RateLimit-Limit": "5000" });
    });
    const poller = new GithubPoller(db, "token");
    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    await poller.pollRepos();
    expect(calls.length).toBeGreaterThan(0);
  });
});
