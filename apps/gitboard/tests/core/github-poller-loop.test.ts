import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../src/core/store.ts";
import { GithubPoller } from "../../src/core/github-poller.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { getIssues, getPrs, getRepoPollState } from "../../src/core/github-store.ts";

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

  it("paginates repo prs/issues and publishes upserts", async () => {
    const registry = new ChannelRegistry();
    const events: unknown[] = [];
    registry.subscribe("github:activity", { id: "t1", send: (msg) => events.push(msg) });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const page = new URL(url).searchParams.get("page");
      if (url.includes("/issues")) {
        if (page === "1") {
          return mockResponse(Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`, body: null, state: "open", user: { login: "alice" }, html_url: "u", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: `2026-03-06T10:${String(index + 1).padStart(2, "0")}:00Z`, closed_at: null })));
        }
        if (page === "2") {
          return mockResponse([{ number: 101, title: "Issue 101", body: null, state: "open", user: { login: "alice" }, html_url: "u", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T12:00:00Z", closed_at: null }]);
        }
      }
      if (url.includes("/pulls")) {
        if (page === "1") {
          return mockResponse(Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `PR ${index + 1}`, body: null, state: "open", merged_at: null, closed_at: null, user: { login: "bob" }, html_url: "u2", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: `2026-03-06T11:${String(index + 1).padStart(2, "0")}:00Z` })));
        }
        if (page === "2") {
          return mockResponse([{ number: 101, title: "PR 101", body: null, state: "open", merged_at: null, closed_at: null, user: { login: "bob" }, html_url: "u2", comments: 0, labels: [], created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T12:00:00Z" }]);
        }
      }
      return mockResponse([], { status: 404 });
    });

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token", { registry });
    await poller.pollRepos();

    expect(getIssues(db, { repo, limit: 200 })).toHaveLength(101);
    expect(getPrs(db, { repo, limit: 200 })).toHaveLength(101);
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

  it("respects Retry-After rate-limit pauses", async () => {
    const startedAt = Date.now();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {
      status: 429,
      headers: { "Retry-After": "3", "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "5000" },
    }));

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token");
    await poller.pollRepos();

    const state = getRepoPollState(db, repo);
    expect(new Date(state.paused_until ?? "").getTime()).toBeGreaterThanOrEqual(startedAt + 3_000);
  });

  it("keeps the longest rate-limit pause under concurrent responses", async () => {
    const poller = new GithubPoller(db, "token");
    const pollerInternals = poller as unknown as { maybePauseForRateLimit(response: Response): boolean; pausedUntil: number };

    pollerInternals.maybePauseForRateLimit(new Response("{}", {
      status: 429,
      headers: { "Retry-After": "10", "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "5000" },
    }));
    const longestPause = pollerInternals.pausedUntil;

    pollerInternals.maybePauseForRateLimit(new Response("{}", {
      status: 429,
      headers: { "Retry-After": "1", "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "5000" },
    }));

    expect(pollerInternals.pausedUntil).toBe(longestPause);
  });

  it("processes due repos with bounded concurrency instead of sleeping between repos", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return mockResponse([]);
    });

    for (const name of ["owner/repo-a", "owner/repo-b", "owner/repo-c"]) {
      db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES (?, ?, 1)").run(name, name);
    }

    const poller = new GithubPoller(db, "token", { repoConcurrency: 2 });
    await poller.pollRepos();

    expect(calls).toHaveLength(9);
    expect(maxActive).toBe(2);
  });

  it("records poll time separately from latest activity so quiet repos are not immediately due again", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      return mockResponse([]);
    });

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token");
    await poller.pollRepos();
    await poller.pollRepos();

    expect(calls).toHaveLength(3);
    const state = getRepoPollState(db, repo);
    expect(state.last_activity_at).toBeNull();
    expect(db.query<{ last_polled_at: string | null }, []>("SELECT last_polled_at FROM github_repos WHERE full_name = 'owner/repo'").get()?.last_polled_at).not.toBeNull();
  });

  it("does not record poll time when GitHub requests fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/issues")) return mockResponse({ message: "temporary failure" }, { status: 500 });
      return mockResponse([]);
    });

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token");
    await poller.pollRepos();

    expect(db.query<{ last_polled_at: string | null }, []>("SELECT last_polled_at FROM github_repos WHERE full_name = 'owner/repo'").get()?.last_polled_at).toBeNull();
  });

  it("persists ETags and reuses them on the next due poll", async () => {
    const requestHeaders: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      if (requestHeaders.length <= 3) {
        const etags = ['"issues-v1"', '"pulls-v1"', '"releases-v1"'];
        return mockResponse([], {}, { ETag: etags[requestHeaders.length - 1] });
      }
      return new Response(null, { status: 304, headers: { "X-RateLimit-Remaining": "1000", "X-RateLimit-Limit": "5000" } });
    });

    db.prepare("INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('owner/repo', 'repo', 1)").run();
    const poller = new GithubPoller(db, "token");
    await poller.pollRepos();

    const firstState = getRepoPollState(db, repo);
    expect(firstState.issue_etag).toBe('"issues-v1"');
    expect(firstState.pr_etag).toBe('"pulls-v1"');
    expect(firstState.release_etag).toBe('"releases-v1"');

    db.prepare("UPDATE github_repos SET last_polled_at = '2020-01-01T00:00:00Z' WHERE full_name = ?").run(repo);
    await poller.pollRepos();

    expect(requestHeaders[3].get("If-None-Match")).toBe('"issues-v1"');
    expect(requestHeaders[4].get("If-None-Match")).toBe('"pulls-v1"');
    expect(requestHeaders[5].get("If-None-Match")).toBe('"releases-v1"');
  });
});
