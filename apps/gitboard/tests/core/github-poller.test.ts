import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../src/core/store.ts";
import {
  getGithubToken,
  transformEvent,
  transformCommits,
  GithubPoller,
  type RawGithubEvent,
} from "../../src/core/github-poller.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { getEvents, getCommits } from "../../src/core/github-store.ts";

const rawPushEvent: RawGithubEvent = {
  id: "raw-push-1",
  type: "PushEvent",
  repo: { name: "owner/repo-a" },
  actor: { login: "alice" },
  created_at: "2026-03-06T10:00:00Z",
  payload: {
    ref: "refs/heads/main",
    size: 2,
    commits: [
      { sha: "sha-1", message: "First commit", author: { name: "alice" }, url: "https://api.github.com/repos/owner/repo-a/commits/sha-1" },
      { sha: "sha-2", message: "Second commit", author: { name: "alice" }, url: "https://api.github.com/repos/owner/repo-a/commits/sha-2" },
    ],
    head: "sha-2",
    before: "sha-0",
  },
};

const rawPREvent: RawGithubEvent = {
  id: "raw-pr-1",
  type: "PullRequestEvent",
  repo: { name: "owner/repo-a" },
  actor: { login: "bob" },
  created_at: "2026-03-06T11:00:00Z",
  payload: {
    action: "opened",
    pull_request: {
      title: "Fix bug",
      body: "Fixes the thing",
      html_url: "https://github.com/owner/repo-a/pull/42",
      additions: 30,
      deletions: 5,
      changed_files: 2,
    },
  },
};

const rawIssueCommentEvent: RawGithubEvent = {
  id: "raw-issue-comment-1",
  type: "IssueCommentEvent",
  repo: { name: "owner/repo-a" },
  actor: { login: "carol" },
  created_at: "2026-03-06T12:00:00Z",
  payload: {
    action: "created",
    issue: {
      title: "Bug report",
      html_url: "https://github.com/owner/repo-a/issues/7",
    },
  },
};

describe("getGithubToken", () => {
  it("returns GITHUB_TOKEN env var if set", () => {
    const restore = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token-123";
    expect(getGithubToken()).toBe("test-token-123");
    if (restore === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = restore;
  });
});

describe("transformEvent", () => {
  it("transforms a PushEvent correctly", () => {
    const event = transformEvent(rawPushEvent);
    expect(event.id).toBe("raw-push-1");
    expect(event.type).toBe("PushEvent");
    expect(event.repo).toBe("owner/repo-a");
    expect(event.actor).toBe("alice");
    expect(event.branch).toBe("main");
    expect(event.commit_count).toBe(2);
    expect(event.title).toBe("First commit");
  });

  it("transforms a PullRequestEvent correctly", () => {
    const event = transformEvent(rawPREvent);
    expect(event.id).toBe("raw-pr-1");
    expect(event.type).toBe("PullRequestEvent");
    expect(event.action).toBe("opened");
    expect(event.title).toBe("Fix bug");
    expect(event.additions).toBe(30);
    expect(event.deletions).toBe(5);
    expect(event.url).toBe("https://github.com/owner/repo-a/pull/42");
  });

  it("handles unknown event types gracefully", () => {
    const raw: RawGithubEvent = {
      id: "raw-watch-1",
      type: "WatchEvent",
      repo: { name: "owner/repo-a" },
      actor: { login: "charlie" },
      created_at: "2026-03-06T12:00:00Z",
      payload: { action: "started" },
    };
    const event = transformEvent(raw);
    expect(event.id).toBe("raw-watch-1");
    expect(event.type).toBe("WatchEvent");
    expect(event.action).toBe("started");
  });
});

describe("transformCommits", () => {
  it("returns empty array for non-PushEvent", () => {
    expect(transformCommits(rawPREvent)).toHaveLength(0);
  });

  it("extracts commits from PushEvent payload", () => {
    const commits = transformCommits(rawPushEvent);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe("sha-1");
    expect(commits[0].author).toBe("alice");
    expect(commits[0].repo).toBe("owner/repo-a");
    expect(commits[0].branch).toBe("main");
    expect(commits[0].event_id).toBe("raw-push-1");
  });
});

// Fake Compare API response matching the rawPushEvent fixture
const fakeCompareResponse = {
  commits: [
    {
      sha: "sha-1",
      commit: { message: "First commit", author: { name: "alice", date: "2026-03-06T10:00:00Z" } },
      html_url: "https://github.com/owner/repo-a/commit/sha-1",
    },
    {
      sha: "sha-2",
      commit: { message: "Second commit\n\nFull body here.", author: { name: "alice", date: "2026-03-06T10:01:00Z" } },
      html_url: "https://github.com/owner/repo-a/commit/sha-2",
    },
  ],
  files: [{ additions: 15, deletions: 3 }, { additions: 5, deletions: 0 }],
};

// Fake PR API response matching the rawPREvent fixture
const fakePRResponse = {
  title: "Fix bug",
  body: "Fixes the thing",
  html_url: "https://github.com/owner/repo-a/pull/42",
  state: "open",
  merged: false,
  merged_at: null,
  closed_at: null,
  user: { login: "bob" },
  additions: 30,
  deletions: 5,
  changed_files: 2,
  comments: 0,
  labels: [],
  created_at: "2026-03-06T11:00:00Z",
  updated_at: "2026-03-06T11:30:00Z",
};

// A PR event that includes the PR number (needed for enrichment)
const rawPREventWithNumber: RawGithubEvent = {
  id: "raw-pr-2",
  type: "PullRequestEvent",
  repo: { name: "owner/repo-a" },
  actor: { login: "bob" },
  created_at: "2026-03-06T11:30:00Z",
  payload: {
    action: "opened",
    pull_request: { number: 42 },
  },
};

function makeFetchMock() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("/compare/")) {
      return new Response(JSON.stringify(fakeCompareResponse), { status: 200 });
    }
    if (url.includes("/pulls/")) {
      return new Response(JSON.stringify(fakePRResponse), { status: 200 });
    }
    // Default: 404 (causes apiGet to return null, triggering payload fallback)
    return new Response("{}", { status: 404 });
  });
}

describe("GithubPoller", () => {
  let db: ReturnType<typeof createDatabase>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-forge-poller-test-"));
    db = createDatabase(join(tmpDir, "state.db"));
    makeFetchMock();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("can be instantiated with a db and token", () => {
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000 });
    expect(poller).toBeDefined();
  });

  it("ingestEvents stores events, commits, and publishes event append", async () => {
    const registry = new ChannelRegistry();
    const messages: unknown[] = [];
    registry.subscribe("github:activity", { id: "sub-1", send: (msg) => messages.push(msg) });
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000, registry });
    await poller.ingestEvents([rawPushEvent]);
    const events = getEvents(db, {});
    const commits = getCommits(db, {});
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("raw-push-1");
    expect(commits).toHaveLength(2);
    // Enriched stats from Compare API
    expect(events[0].additions).toBe(20);
    expect(events[0].deletions).toBe(3);
    expect(events[0].changed_files).toBe(2);
    expect(commits[0].message_full).toBeDefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: "github:event.append", data: expect.objectContaining({ id: "raw-push-1", additions: 20, title: "Second commit" }) });
  });

  it("ingestEvents enriches PR events from PR API and publishes event append", async () => {
    const registry = new ChannelRegistry();
    const messages: unknown[] = [];
    registry.subscribe("github:activity", { id: "sub-1", send: (msg) => messages.push(msg) });
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000, registry });
    await poller.ingestEvents([rawPREventWithNumber]);
    const events = getEvents(db, {});
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Fix bug");
    expect(events[0].additions).toBe(30);
    expect(events[0].deletions).toBe(5);
    expect(events[0].changed_files).toBe(2);
    expect(events[0].url).toBe("https://github.com/owner/repo-a/pull/42");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: "github:event.append", data: expect.objectContaining({ id: "raw-pr-2", title: "Fix bug", url: "https://github.com/owner/repo-a/pull/42" }) });
  });

  it("falls back to payload commits when Compare API fails", async () => {
    // Override mock to always return 404
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000 });
    await poller.ingestEvents([rawPushEvent]);
    const commits = getCommits(db, {});
    // Payload has 2 commits — these are stored as fallback
    expect(commits).toHaveLength(2);
  });

  it("deduplicates events on repeated ingest and publishes append once", async () => {
    const registry = new ChannelRegistry();
    const messages: unknown[] = [];
    registry.subscribe("github:activity", { id: "sub-1", send: (msg) => messages.push(msg) });
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000, registry });
    await poller.ingestEvents([rawPushEvent]);
    await poller.ingestEvents([rawPushEvent]);
    expect(getEvents(db, {})).toHaveLength(1);
    expect(getCommits(db, {})).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: "github:event.append", data: expect.objectContaining({ id: "raw-push-1" }) });
  });

  it("publishes append for non-PR non-push user events", async () => {
    const registry = new ChannelRegistry();
    const messages: unknown[] = [];
    registry.subscribe("github:activity", { id: "sub-1", send: (msg) => messages.push(msg) });
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000, registry });
    await poller.ingestEvents([rawIssueCommentEvent]);
    expect(getEvents(db, {})).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: "github:event.append", data: expect.objectContaining({ id: "raw-issue-comment-1", type: "IssueCommentEvent", title: "Bug report", url: "https://github.com/owner/repo-a/issues/7" }) });
  });

  it("start/stop lifecycle works without errors", () => {
    const poller = new GithubPoller(db, "test-token", { intervalMs: 300_000 });
    poller.start("testuser");
    poller.stop();
  });
});
