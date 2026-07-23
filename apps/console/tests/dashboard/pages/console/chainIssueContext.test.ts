import { describe, expect, it } from "vitest";
import { buildChainIssueContext } from "../../../../src/dashboard/pages/console/specialists/chainIssueContext.ts";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";
import type { GraphResponse } from "../../../../src/types/graph.ts";

describe("buildChainIssueContext", () => {
  it("returns touched chain nodes and graph-neighbor issues for any relationship", () => {
    const context = buildChainIssueContext(chain(), graph());

    expect(context.touched.map((node) => node.id)).toEqual(["forge-1"]);
    expect(context.related.map((item) => [item.node.id, item.edge.type, item.direction])).toEqual([
      ["forge-blocker", "blocks", "outgoing"],
      ["forge-parent", "parent-child", "incoming"],
    ]);
  });
});

function chain(): ChainSummary {
  return {
    chainId: "chain-a",
    rootBeadId: "forge-1",
    title: "chain-a",
    jobs: [{
      repoSlug: "repo-a",
      beadId: "forge-1",
      jobId: "job-a",
      chainId: "chain-a",
      epicId: null,
      chainKind: "executor",
      specialist: "executor",
      status: "done",
      updatedAt: "2026-05-31T00:00:00.000Z",
      lastOutput: null,
      turns: null,
      tools: null,
      model: null,
    }],
    status: "done",
    roles: [{ role: "executor", status: "done" }],
    elapsedMs: 0,
    lastMessage: "",
    lastUpdatedAt: "2026-05-31T00:00:00.000Z",
  };
}

function graph(): GraphResponse {
  return {
    project_id: "project-a",
    repo_slug: "repo-a",
    generated_at: "2026-05-31T00:00:00.000Z",
    nodes: [
      node("forge-1", "Root", "task", 1, "in_progress"),
      node("forge-blocker", "Blocked by root", "bug", 0, "blocked"),
      node("forge-parent", "Parent", "epic", 1, "open"),
      node("forge-unrelated", "Unrelated", "task", 3, "open"),
    ],
    edges: [
      { from: "forge-1", to: "forge-blocker", type: "blocks" },
      { from: "forge-parent", to: "forge-1", type: "parent-child" },
      { from: "forge-unrelated", to: "forge-parent", type: "related" },
    ],
    specialists: [],
  };
}

function node(id: string, title: string, type: "task" | "bug" | "epic", priority: 0 | 1 | 3, status: "open" | "in_progress" | "blocked") {
  return { id, title, type, priority, status, assignee: null, closed_at: null, superseded_by: null };
}
