import { describe, expect, it, vi } from "vitest";
import { GithubPoller, type RawGithubEvent, transformEvent } from "../src/github/poller.ts";
import { makeGithubAdapterLogEntry, type GithubAdapterLogEntry, type GithubActivityPublisher, NOOP_GITHUB_ACTIVITY_PUBLISHER, NOOP_GITHUB_ADAPTER_LOGGER } from "../src/github/ports.ts";
import { getGithubToken, getAuthenticatedUsername } from "../src/github/token.ts";
import { discoverViaGhCli, filterRepos, type DiscoveredRepo } from "../src/github/discover.ts";
import { parseFrontmatter, clearReadmeCache } from "../src/github/readme.ts";

const rawPushEvent: RawGithubEvent = {
  id: "core-push-1",
  type: "PushEvent",
  repo: { name: "owner/repo-a" },
  actor: { login: "alice" },
  created_at: "2026-06-07T10:00:00Z",
  payload: {
    ref: "refs/heads/main",
    size: 1,
    commits: [
      { sha: "core-sha-1", message: "Core push", author: { name: "alice" }, url: "https://api.github.com/repos/owner/repo-a/commits/core-sha-1" },
    ],
    head: "core-sha-1",
    before: "core-sha-0",
  },
};

class CollectingPublisher implements GithubActivityPublisher {
  events: Array<{ channel: string; event: string; data: unknown; version: string }> = [];
  publish(channel: string, event: string, data: unknown, version: string): void {
    this.events.push({ channel, event, data, version });
  }
}

class CollectingLogger {
  entries: GithubAdapterLogEntry[] = [];
  emit(entry: GithubAdapterLogEntry): void {
    this.entries.push(entry);
  }
}

type PollerApi = GithubPoller & {
  apiGetWithMeta<T>(path: string, repo?: string, endpoint?: string, persistedEtag?: string | null): Promise<{
    data: T | null;
    status: "ok" | "not_modified" | "error";
    etag: string | null;
  }>;
};

describe("core github poller ports and helpers", () => {
  it("transformEvent returns the same shape as the legacy app transformer", () => {
    const event = transformEvent(rawPushEvent);
    expect(event.id).toBe("core-push-1");
    expect(event.branch).toBe("main");
    expect(event.commit_count).toBe(1);
  });

  it("constructs a poller with injected publisher and logger and exposes them", () => {
    const publisher = new CollectingPublisher();
    const logger = new CollectingLogger();
    const poller = new GithubPoller({} as never, "test-token", { registry: publisher, logger });
    expect(poller).toBeDefined();
    expect(publisher.events).toHaveLength(0);
    expect(logger.entries).toHaveLength(0);
  });

  it("noop publisher and logger are usable stand-ins", () => {
    const poller = new GithubPoller({} as never, "test-token", {
      registry: NOOP_GITHUB_ACTIVITY_PUBLISHER,
      logger: NOOP_GITHUB_ADAPTER_LOGGER,
    });
    expect(() => poller.stop()).not.toThrow();
  });

  it("makeGithubAdapterLogEntry produces a stable shape", () => {
    const entry = makeGithubAdapterLogEntry("poller", "test.event", "info", "msg", { k: 1 });
    expect(entry.component).toBe("poller");
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("msg");
    expect(entry.data).toEqual({ k: 1 });
  });

  it("getGithubToken prefers GITHUB_TOKEN env var", () => {
    const restore = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token-123";
    expect(getGithubToken()).toBe("test-token-123");
    if (restore === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = restore;
  });

  it("emits etag.hit_304 and preserves persisted ETag on conditional GitHub 304", async () => {
    const logger = new CollectingLogger();
    const poller = new GithubPoller({} as never, "test-token", { logger }) as PollerApi;
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { ETag: "persisted-etag" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await poller.apiGetWithMeta<{ id: string }>("/repos/owner/repo/issues", "owner/repo", "issues", "persisted-etag");
      expect(result).toEqual({ data: null, status: "not_modified", etag: "persisted-etag" });
      expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/issues", expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": "persisted-etag" }),
      }));
      expect(logger.entries).toContainEqual(expect.objectContaining({
        component: "poller",
        event: "etag.hit_304",
        level: "debug",
        data: { repo: "owner/repo", endpoint: "issues" },
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes degraded source-health and rate_limit.changed log on GitHub rate-limit pause", async () => {
    const publisher = new CollectingPublisher();
    const logger = new CollectingLogger();
    const poller = new GithubPoller({} as never, "test-token", { registry: publisher, logger, protocolVersion: "test-v1" }) as PollerApi;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), {
      status: 403,
      headers: {
        "Retry-After": "30",
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1770000000",
      },
    })));
    try {
      const result = await poller.apiGetWithMeta<{ ok: boolean }>("/rate-limited", "owner/repo", "issues");
      expect(result.status).toBe("error");
      expect(publisher.events).toHaveLength(1);
      expect(publisher.events[0]).toMatchObject({
        channel: "github:activity",
        event: "github:source_health",
      });
      expect(typeof publisher.events[0]?.version).toBe("string");
      expect(publisher.events[0]?.version).toBe((publisher.events[0]?.data as { checked_at?: string }).checked_at);
      expect(publisher.events[0]?.data).toMatchObject({
        source: "github",
        status: "degraded",
        rate_limit: { limit: 5000, remaining: 0 },
      });
      expect(logger.entries).toContainEqual(expect.objectContaining({
        component: "poller",
        event: "rate_limit.changed",
        level: "warn",
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("core github discover helpers", () => {
  it("filterRepos drops old, private (when disabled), and null-pushed repos", () => {
    const repos: DiscoveredRepo[] = [
      { full_name: "alice/recent-public", is_private: false, pushed_at: new Date().toISOString() },
      { full_name: "alice/recent-private", is_private: true, pushed_at: new Date().toISOString() },
      { full_name: "alice/old-repo", is_private: false, pushed_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() },
      { full_name: "alice/null-pushed", is_private: false, pushed_at: null },
    ];
    const filtered = filterRepos(repos);
    const names = filtered.map((r) => r.full_name);
    expect(names).toContain("alice/recent-public");
    expect(names).toContain("alice/recent-private");
    expect(names).not.toContain("alice/old-repo");
    expect(names).not.toContain("alice/null-pushed");

    const publicOnly = filterRepos(repos, { includePrivate: false });
    expect(publicOnly.map((r) => r.full_name)).not.toContain("alice/recent-private");
  });

  it("discoverViaGhCli parses JSON output when gh is available", () => {
    const fakeSpawnSync = () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify([
        { nameWithOwner: "alice/repo-a", isPrivate: false, pushedAt: "2026-03-01T00:00:00Z" },
        { nameWithOwner: "alice/repo-b", isPrivate: true, pushedAt: "2026-02-01T00:00:00Z" },
      ])),
      stderr: Buffer.from(""),
      success: true,
    });
    const repos = discoverViaGhCli(fakeSpawnSync as typeof Bun.spawnSync);
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({ full_name: "alice/repo-a", is_private: false, pushed_at: "2026-03-01T00:00:00Z" });
  });
});

describe("core github readme helpers", () => {
  it("parseFrontmatter extracts a simple YAML block", () => {
    const text = "---\ntitle: Hello\nauthor: alice\n---\nbody";
    const fm = parseFrontmatter(text);
    expect(fm).toEqual({ title: "Hello", author: "alice" });
  });

  it("parseFrontmatter returns null on missing delimiters", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
  });

  it("clearReadmeCache does not throw on a fresh module state", () => {
    expect(() => clearReadmeCache()).not.toThrow();
  });
});
