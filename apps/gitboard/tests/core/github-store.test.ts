import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../../../packages/core/src/github/database.ts";
import {
  insertEvent,
  insertCommit,
  upsertRepo,
  getEvents,
  getEvent,
  getCommits,
  getRepos,
  updateRepo,
  getContributions,
  getSummary,
  getRepoStats,
  updateCommitFullMessage,
  isTruncated,
  type GithubEvent,
  type GithubCommit,
  type GithubRepo,
} from "../../../../packages/core/src/github/index.ts";
import {
  getEvents as getCoreEvents,
  insertEvent as insertCoreEvent,
} from "../../../../packages/core/src/github/index.ts";
import type { Database } from "bun:sqlite";

const makeEvent = (overrides: Partial<GithubEvent> = {}): GithubEvent => ({
  id: "evt-001",
  type: "PushEvent",
  repo: "owner/repo-a",
  branch: "main",
  actor: "alice",
  action: null,
  title: "Add feature",
  body: null,
  url: "https://github.com/owner/repo-a",
  additions: 50,
  deletions: 10,
  changed_files: 3,
  commit_count: 2,
  created_at: "2026-03-06T10:00:00Z",
  ...overrides,
});

const makeCommit = (overrides: Partial<GithubCommit> = {}): GithubCommit => ({
  sha: "abc123",
  repo: "owner/repo-a",
  branch: "main",
  author: "alice",
  message: "Add feature",
  url: "https://github.com/owner/repo-a/commit/abc123",
  additions: 50,
  deletions: 10,
  changed_files: 3,
  event_id: "evt-001",
  committed_at: "2026-03-06T10:00:00Z",
  ...overrides,
});

const makeRepo = (overrides: Partial<GithubRepo> = {}): GithubRepo => ({
  full_name: "owner/repo-a",
  display_name: "repo-a",
  tracked: true,
  group_name: "core",
  last_polled_at: null,
  color: "#3b82f6",
  ...overrides,
});

describe("github core store", () => {
  let db: ReturnType<typeof createDatabase>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-forge-gh-test-"));
    const dbPath = join(tmpDir, "state.db");
    db = createDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps the app module as a compatibility re-export of the core store", () => {
    expect(insertEvent).toBe(insertCoreEvent);
    expect(getEvents).toBe(getCoreEvents);
  });

  describe("insertEvent", () => {
    it("inserts a github event", () => {
      insertEvent(db, makeEvent());
      const events = getEvents(db, {});
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("evt-001");
    });

    it("is idempotent — duplicate ID is ignored", () => {
      insertEvent(db, makeEvent());
      insertEvent(db, makeEvent()); // same ID
      const events = getEvents(db, {});
      expect(events).toHaveLength(1);
    });
  });

  describe("insertCommit", () => {
    it("inserts a commit", () => {
      insertEvent(db, makeEvent());
      insertCommit(db, makeCommit());
      const commits = getCommits(db, {});
      expect(commits).toHaveLength(1);
      expect(commits[0].sha).toBe("abc123");
    });

    it("is idempotent — duplicate sha is ignored", () => {
      insertEvent(db, makeEvent());
      insertCommit(db, makeCommit());
      insertCommit(db, makeCommit());
      expect(getCommits(db, {})).toHaveLength(1);
    });
  });

  describe("upsertRepo", () => {
    it("inserts a new repo", () => {
      upsertRepo(db, makeRepo());
      expect(getRepos(db)).toHaveLength(1);
    });

    it("updates existing repo on conflict", () => {
      upsertRepo(db, makeRepo());
      upsertRepo(db, makeRepo({ display_name: "updated-name" }));
      const repos = getRepos(db);
      expect(repos).toHaveLength(1);
      expect(repos[0].display_name).toBe("updated-name");
    });
  });

  describe("getEvents", () => {
    beforeEach(() => {
      insertEvent(db, makeEvent({ id: "e1", repo: "owner/repo-a", type: "PushEvent", created_at: "2026-03-06T09:00:00Z" }));
      insertEvent(db, makeEvent({ id: "e2", repo: "owner/repo-b", type: "PullRequestEvent", created_at: "2026-03-06T10:00:00Z" }));
      insertEvent(db, makeEvent({ id: "e3", repo: "owner/repo-a", type: "PushEvent", created_at: "2026-03-07T10:00:00Z" }));
    });

    it("returns all events when no filters", () => {
      expect(getEvents(db, {})).toHaveLength(3);
    });

    it("filters by repo", () => {
      const events = getEvents(db, { repos: ["owner/repo-a"] });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.repo === "owner/repo-a")).toBe(true);
    });

    it("filters by type", () => {
      const events = getEvents(db, { types: ["PullRequestEvent"] });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("e2");
    });

    it("filters by date range", () => {
      const events = getEvents(db, { from: "2026-03-07T00:00:00Z" });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("e3");
    });

    it("paginates with limit and offset", () => {
      const page1 = getEvents(db, { limit: 2, offset: 0 });
      const page2 = getEvents(db, { limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });
  });

  describe("getEvent", () => {
    it("returns event by id", () => {
      insertEvent(db, makeEvent());
      const event = getEvent(db, "evt-001");
      expect(event?.id).toBe("evt-001");
    });

    it("returns null for unknown id", () => {
      expect(getEvent(db, "unknown")).toBeNull();
    });
  });

  describe("getCommits", () => {
    it("filters by repo", () => {
      insertEvent(db, makeEvent({ id: "e1", repo: "owner/repo-a" }));
      insertEvent(db, makeEvent({ id: "e2", repo: "owner/repo-b" }));
      insertCommit(db, makeCommit({ sha: "s1", repo: "owner/repo-a", event_id: "e1" }));
      insertCommit(db, makeCommit({ sha: "s2", repo: "owner/repo-b", event_id: "e2" }));
      expect(getCommits(db, { repo: "owner/repo-a" })).toHaveLength(1);
    });
  });

  describe("updateRepo", () => {
    it("updates repo fields", () => {
      upsertRepo(db, makeRepo());
      updateRepo(db, "owner/repo-a", { display_name: "new-name", color: "#ff0000" });
      const repos = getRepos(db);
      expect(repos[0].display_name).toBe("new-name");
      expect(repos[0].color).toBe("#ff0000");
    });
  });

  describe("getSummary", () => {
    it("returns counts for today period", () => {
      insertEvent(db, makeEvent({ id: "e1", created_at: new Date().toISOString() }));
      const summary = getSummary(db, "today");
      expect(summary.events).toBeGreaterThanOrEqual(1);
    });

    it("accepts week and month periods", () => {
      const week = getSummary(db, "week");
      const month = getSummary(db, "month");
      expect(week).toHaveProperty("events");
      expect(month).toHaveProperty("commits");
    });
  });

  describe("getContributions", () => {
    it("returns array of daily contribution counts", () => {
      const contribs = getContributions(db, 12);
      expect(Array.isArray(contribs)).toBe(true);
    });

    it("includes entries with date and count fields", () => {
      insertEvent(db, makeEvent({ id: "e1", created_at: new Date().toISOString() }));
      const contribs = getContributions(db, 4);
      contribs.forEach((c) => {
        expect(c).toHaveProperty("date");
        expect(c).toHaveProperty("count");
      });
    });
  });

  describe("getRepoStats", () => {
    beforeEach(() => {
      const now = new Date().toISOString();
      const old = "2020-01-01T00:00:00Z";
      insertEvent(db, makeEvent({ id: "r1", repo: "owner/api", type: "PushEvent", action: null, created_at: now }));
      insertEvent(db, makeEvent({ id: "r2", repo: "owner/api", type: "PushEvent", action: null, created_at: now }));
      insertEvent(db, makeEvent({ id: "r3", repo: "owner/api", type: "PullRequestEvent", action: "opened", created_at: now }));
      insertEvent(db, makeEvent({ id: "r4", repo: "owner/api", type: "PullRequestEvent", action: "closed", created_at: now }));
      insertEvent(db, makeEvent({ id: "r5", repo: "owner/worker", type: "PushEvent", action: null, created_at: now }));
      insertEvent(db, makeEvent({ id: "r6", repo: "owner/api", type: "PushEvent", action: null, created_at: old }));
    });

    it("returns per-repo stats array", () => {
      const stats = getRepoStats(db);
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThanOrEqual(2);
    });

    it("counts pushes in last 24h", () => {
      const stats = getRepoStats(db);
      const api = stats.find((s) => s.full_name === "owner/api");
      expect(api?.pushes).toBe(2);
    });

    it("counts open PRs", () => {
      const stats = getRepoStats(db);
      const api = stats.find((s) => s.full_name === "owner/api");
      expect(api?.prs_open).toBe(1);
    });

    it("counts closed PRs", () => {
      const stats = getRepoStats(db);
      const api = stats.find((s) => s.full_name === "owner/api");
      expect(api?.prs_closed).toBe(1);
    });

    it("excludes events older than 24h", () => {
      const stats = getRepoStats(db);
      const api = stats.find((s) => s.full_name === "owner/api");
      expect(api?.pushes).toBe(2); // r6 (old) not counted
    });

    it("returns correct stats for second repo", () => {
      const stats = getRepoStats(db);
      const worker = stats.find((s) => s.full_name === "owner/worker");
      expect(worker?.pushes).toBe(1);
      expect(worker?.prs_open).toBe(0);
    });
  });

  describe("message_full column", () => {
    it("github_commits table has message_full column after createDatabase", () => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(github_commits)")
        .all()
        .map((r) => r.name);
      expect(cols).toContain("message_full");
    });

    it("insertCommit stores null message_full by default", () => {
      insertEvent(db, makeEvent());
      insertCommit(db, makeCommit());
      expect(getCommits(db, {})[0].message_full).toBeNull();
    });

    it("updateCommitFullMessage persists full message", () => {
      insertEvent(db, makeEvent());
      insertCommit(db, makeCommit({ sha: "sha-full" }));
      updateCommitFullMessage(db, "sha-full", "subject\n\nbody here");
      expect(getCommits(db, {})[0].message_full).toBe("subject\n\nbody here");
    });
  });

  describe("isTruncated", () => {
    it("returns true for long single-line message >= 70 chars", () => {
      expect(isTruncated("a".repeat(70))).toBe(true);
    });

    it("returns false for short messages", () => {
      expect(isTruncated("fix: small bug")).toBe(false);
    });

    it("returns false for messages with newlines", () => {
      expect(isTruncated("a".repeat(80) + "\n\nbody text")).toBe(false);
    });
  });
});
