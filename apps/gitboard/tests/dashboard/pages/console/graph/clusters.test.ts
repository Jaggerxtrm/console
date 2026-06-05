import { describe, expect, it } from "vitest";
import { partitionGraph } from "../../../../../src/dashboard/pages/console/graph/clusters.ts";
import type { GraphNode, GraphResponse, GraphSpecialist } from "../../../../../src/types/graph.ts";

const specialistMap = new Map<string, GraphSpecialist>();

function node(id: string, status: GraphNode["status"] = "open", priority: GraphNode["priority"] = 2): GraphNode {
  return {
    id,
    title: id,
    type: "task",
    priority,
    status,
    assignee: null,
    closed_at: status === "closed" ? "2026-06-01T00:00:00.000Z" : null,
    superseded_by: null,
  };
}

function graph(nodes: GraphNode[], edges: GraphResponse["edges"]): GraphResponse {
  return {
    project_id: "specialists",
    repo_slug: "specialists",
    generated_at: "2026-06-04T00:00:00.000Z",
    nodes,
    edges,
    specialists: [],
  };
}

describe("partitionGraph", () => {
  it("renders closed historical nodes that are connected by dependency edges", () => {
    const partition = partitionGraph(
      graph(
        [node("open-1"), node("closed-source", "closed"), node("closed-target", "closed"), node("closed-orphan", "closed")],
        [{ from: "closed-source", to: "closed-target", type: "blocks" }],
      ),
      specialistMap,
    );

    expect(partition.clusters).toHaveLength(1);
    expect(partition.clusters[0].nodes.map((n) => n.id).sort()).toEqual(["closed-source", "closed-target"]);
    expect(partition.clusters[0].edges).toEqual([{ from: "closed-source", to: "closed-target", type: "blocks" }]);
    expect(partition.buckets.closed.map((n) => n.id)).toEqual(["closed-orphan"]);
    expect(partition.orphans.map((n) => n.id)).toContain("open-1");
  });
});
