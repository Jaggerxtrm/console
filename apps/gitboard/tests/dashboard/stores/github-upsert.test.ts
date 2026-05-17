import { describe, it, expect, beforeEach } from "vitest";
import { useGithubStore } from "../../../src/dashboard/stores/github.ts";
import type { GithubPr, GithubIssue } from "../../../src/types/github.ts";

const pr1: GithubPr = { repo: "owner/repo", number: 1, title: "A", body: null, state: "open", author: "alice", url: null, additions: null, deletions: null, changed_files: null, comment_count: 0, label_names: null, created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T10:01:00Z", merged_at: null, closed_at: null };
const pr2: GithubPr = { ...pr1, title: "B", updated_at: "2026-03-06T10:02:00Z" };
const issue1: GithubIssue = { repo: "owner/repo", number: 7, title: "I1", body: null, state: "open", author: "alice", url: null, comment_count: 0, label_names: null, created_at: "2026-03-06T10:00:00Z", updated_at: "2026-03-06T10:01:00Z", closed_at: null };
const issue2: GithubIssue = { ...issue1, title: "I2", updated_at: "2026-03-06T10:02:00Z" };

beforeEach(() => {
  useGithubStore.setState({ events: [], selectedEvent: null, selectedEventCommits: [], repos: [], contributions: [], summary: null, filter: {}, loading: false, error: null, repoStats: {}, unreadRepos: new Set(), prs: [pr1], issues: [issue1], releases: [] });
});

describe("upsertPr", () => {
  it("replaces by repo+number and keeps newest first", () => {
    useGithubStore.getState().upsertPr(pr2);
    expect(useGithubStore.getState().prs).toHaveLength(1);
    expect(useGithubStore.getState().prs[0].title).toBe("B");
  });
});

describe("upsertIssue", () => {
  it("replaces by repo+number and keeps newest first", () => {
    useGithubStore.getState().upsertIssue(issue2);
    expect(useGithubStore.getState().issues).toHaveLength(1);
    expect(useGithubStore.getState().issues[0].title).toBe("I2");
  });
});
