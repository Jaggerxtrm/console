import { beforeEach, describe, expect, it } from "vitest";
import type { BeadIssue, Memory } from "../../types/beads.ts";
import { useBeadSideDrawer } from "./useBeadSideDrawer.ts";

describe("useBeadSideDrawer", () => {
  beforeEach(() => {
    useBeadSideDrawer.setState({
      beadId: null,
      jobId: null,
      chainId: null,
      projectId: null,
      issueById: new Map(),
      fallbackIssue: null,
      memories: [],
      tab: "overview",
      backStack: [],
    });
  });

  it("opens a bead inspector target with optional job and fallback issue", () => {
    const issue = beadIssue("forge-one");

    useBeadSideDrawer.getState().open({ beadId: issue.id, jobId: "job-1", chainId: "chain-1", issue });

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-one");
    expect(useBeadSideDrawer.getState().jobId).toBe("job-1");
    expect(useBeadSideDrawer.getState().chainId).toBe("chain-1");
    expect(useBeadSideDrawer.getState().fallbackIssue?.title).toBe("Issue forge-one");
    expect(useBeadSideDrawer.getState().tab).toBe("overview");
  });

  it("preserves bead navigation history and restores previous targets", () => {
    useBeadSideDrawer.getState().open({ beadId: "forge-one", jobId: "job-1", chainId: "chain-1", issue: beadIssue("forge-one") });
    useBeadSideDrawer.getState().setTab("activity");
    useBeadSideDrawer.getState().open({ beadId: "forge-two", issue: beadIssue("forge-two") });

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-two");
    expect(useBeadSideDrawer.getState().backStack).toHaveLength(1);
    expect(useBeadSideDrawer.getState().tab).toBe("overview");

    useBeadSideDrawer.getState().back();

    expect(useBeadSideDrawer.getState().beadId).toBe("forge-one");
    expect(useBeadSideDrawer.getState().jobId).toBe("job-1");
    expect(useBeadSideDrawer.getState().chainId).toBe("chain-1");
    expect(useBeadSideDrawer.getState().backStack).toHaveLength(0);
  });

  it("stores project context for live bead data and memories", () => {
    const issue = beadIssue("forge-one");
    const memory: Memory = {
      id: "mem-1",
      content: "forge-one needs inspector coverage",
      type: "learned",
      tags: ["console"],
      created_at: "2026-06-06T00:00:00.000Z",
      issue_id: "forge-one",
      project_id: "repo",
    };

    useBeadSideDrawer.getState().setContext("repo", new Map([[issue.id, issue]]), [memory]);

    expect(useBeadSideDrawer.getState().projectId).toBe("repo");
    expect(useBeadSideDrawer.getState().issueById.get("forge-one")).toEqual(issue);
    expect(useBeadSideDrawer.getState().memories).toEqual([memory]);
  });
});

function beadIssue(id: string): BeadIssue {
  return {
    id,
    title: `Issue ${id}`,
    description: null,
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: null,
    created_at: "2026-06-06T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-06-06T00:00:00.000Z",
    project_id: "repo",
    dependencies: [],
    related_ids: [],
    labels: [],
  };
}
