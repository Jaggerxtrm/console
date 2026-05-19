import { describe, it, expect, beforeEach } from "vitest";
import { useGithubStore } from "../../../src/dashboard/stores/github.ts";
import type { GithubEvent, GithubRepo, Summary, RepoStat } from "../../../src/types/github.ts";

const evt1: GithubEvent = {
  id: "e1",
  type: "PushEvent",
  repo: "owner/repo",
  branch: "main",
  actor: "alice",
  action: null,
  title: "fix: bug",
  body: null,
  url: null,
  additions: 10,
  deletions: 2,
  changed_files: 1,
  commit_count: 1,
  created_at: "2026-03-06T10:00:00Z",
};

const evt2: GithubEvent = { ...evt1, id: "e2", type: "PullRequestEvent", action: "opened" };

beforeEach(() => {
  useGithubStore.setState({
    events: [],
    selectedEvent: null,
    selectedEventCommits: [],
    repos: [],
    repoStats: {},
    unreadRepos: new Set(),
    contributions: [],
    summary: null,
    filter: {},
    loading: false,
    error: null,
    releases: [],
  });
});

describe("setEvents", () => {
  it("replaces event list", () => {
    useGithubStore.getState().setEvents([evt1, evt2]);
    expect(useGithubStore.getState().events).toHaveLength(2);
  });
});

describe("appendEvents", () => {
  it("adds new events, deduplicates by id", () => {
    useGithubStore.getState().setEvents([evt1]);
    useGithubStore.getState().appendEvents([evt1, evt2]);
    expect(useGithubStore.getState().events).toHaveLength(2);
  });
});

describe("prependEvent", () => {
  it("adds new event at beginning", () => {
    useGithubStore.getState().setEvents([evt2]);
    useGithubStore.getState().prependEvent(evt1);
    expect(useGithubStore.getState().events[0].id).toBe("e1");
  });

  it("does not duplicate existing event", () => {
    useGithubStore.getState().setEvents([evt1]);
    useGithubStore.getState().prependEvent(evt1);
    expect(useGithubStore.getState().events).toHaveLength(1);
  });
});

describe("selectEvent", () => {
  it("sets selectedEvent and clears commits", () => {
    useGithubStore.getState().setSelectedEventCommits([
      { sha: "a1", repo: "r", branch: null, author: "x", message: "m", url: null, additions: null, deletions: null, changed_files: null, event_id: "e1", committed_at: "2026-03-06T10:00:00Z" },
    ]);
    useGithubStore.getState().selectEvent(evt1);
    expect(useGithubStore.getState().selectedEvent?.id).toBe("e1");
    expect(useGithubStore.getState().selectedEventCommits).toHaveLength(0);
  });
});

describe("setRepos", () => {
  it("sets repo list", () => {
    const repo: GithubRepo = { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null };
    useGithubStore.getState().setRepos([repo]);
    expect(useGithubStore.getState().repos).toHaveLength(1);
  });
});

describe("updateRepo", () => {
  it("patches a single repo by full_name", () => {
    const repo: GithubRepo = { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null };
    useGithubStore.getState().setRepos([repo]);
    useGithubStore.getState().updateRepo("owner/repo", { color: "#ff0000" });
    expect(useGithubStore.getState().repos[0].color).toBe("#ff0000");
  });
});

describe("setFilter / resetFilter", () => {
  it("merges filter fields", () => {
    useGithubStore.getState().setFilter({ repos: ["owner/repo"] });
    useGithubStore.getState().setFilter({ branch: "main" });
    const f = useGithubStore.getState().filter;
    expect(f.repos).toEqual(["owner/repo"]);
    expect(f.branch).toBe("main");
  });

  it("resets filter to empty", () => {
    useGithubStore.getState().setFilter({ repos: ["owner/repo"] });
    useGithubStore.getState().resetFilter();
    expect(useGithubStore.getState().filter).toEqual({});
  });
});

describe("setSummary", () => {
  it("stores summary stats", () => {
    const s: Summary = { events: 10, pushes: 5, prs: 3, commits: 20, repos: 4 };
    useGithubStore.getState().setSummary(s);
    expect(useGithubStore.getState().summary?.pushes).toBe(5);
  });
});

describe("setLoading / setError", () => {
  it("sets loading flag", () => {
    useGithubStore.getState().setLoading(true);
    expect(useGithubStore.getState().loading).toBe(true);
  });

  it("sets and clears error", () => {
    useGithubStore.getState().setError("oops");
    expect(useGithubStore.getState().error).toBe("oops");
    useGithubStore.getState().setError(null);
    expect(useGithubStore.getState().error).toBeNull();
  });
});

describe("repoStats", () => {
  it("setRepoStats stores stats keyed by full_name", () => {
    const stat: RepoStat = { full_name: "owner/api", pushes: 5, prs_open: 2, prs_closed: 1, issues_open: 3, releases: 1, last_event_at: "2026-03-07T10:00:00Z" };
    useGithubStore.getState().setRepoStats([stat]);
    expect(useGithubStore.getState().repoStats["owner/api"].pushes).toBe(5);
  });

  it("replaces previous stats on new setRepoStats call", () => {
    useGithubStore.getState().setRepoStats([{ full_name: "owner/api", pushes: 5, prs_open: 0, prs_closed: 0, issues_open: 0, releases: 0, last_event_at: null }]);
    useGithubStore.getState().setRepoStats([{ full_name: "owner/new", pushes: 1, prs_open: 0, prs_closed: 0, issues_open: 0, releases: 0, last_event_at: null }]);
    expect(useGithubStore.getState().repoStats["owner/api"]).toBeUndefined();
    expect(useGithubStore.getState().repoStats["owner/new"].pushes).toBe(1);
  });
});

describe("unreadRepos", () => {
  it("markRepoUnread adds repo to unread set", () => {
    useGithubStore.getState().markRepoUnread("owner/api");
    expect(useGithubStore.getState().unreadRepos.has("owner/api")).toBe(true);
  });

  it("clearRepoUnread removes repo from unread set", () => {
    useGithubStore.getState().markRepoUnread("owner/api");
    useGithubStore.getState().clearRepoUnread("owner/api");
    expect(useGithubStore.getState().unreadRepos.has("owner/api")).toBe(false);
  });
});
