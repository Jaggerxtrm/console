// forge-2a8a.4 cleanup — layoutGraph was deleted in forge-2a8a.2; layout work
// now happens inside React Flow via dagre. These tests cover buildClusterFlow,
// the pure function that maps a partitionGraph cluster to React Flow nodes +
// edges with position-aware handle picking.

import { describe, expect, it } from "vitest";
import { buildClusterFlow } from "../../../../../src/dashboard/pages/console/graph/buildFlowGraph.ts";
import type { ClusterGroup } from "../../../../../src/dashboard/pages/console/graph/clusters.ts";
import type { GraphSpecialist } from "../../../../../src/types/graph.ts";

const specialists = new Map<string, GraphSpecialist>();

function cluster(nodes: ClusterGroup["nodes"], edges: ClusterGroup["edges"]): ClusterGroup {
  return {
    id: "test",
    name: `${nodes.length} nodes`,
    nodes,
    edges,
    hasP0: nodes.some((n) => n.priority === 0),
    hasRunning: false,
  };
}

const node = (id: string, priority: 0 | 1 | 2 | 3 | 4 = 2) => ({
  id, title: id, type: "task" as const, priority,
  status: "open" as const, assignee: null, closed_at: null, superseded_by: null,
});

describe("buildClusterFlow", () => {
  it("emits one React Flow node per cluster node, all type='beadNode'", () => {
    const c = cluster(
      [node("a"), node("b"), node("c")],
      [{ from: "a", to: "b", type: "blocks" }],
    );
    const flow = buildClusterFlow(c, specialists);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.nodes.every((n) => n.type === "beadNode")).toBe(true);
    expect(flow.nodes.every((n) => n.draggable === false)).toBe(true);
  });

  it("forward blocks edge uses right→left handles", () => {
    const c = cluster(
      [node("a"), node("b")],
      [{ from: "a", to: "b", type: "blocks" }],
    );
    const flow = buildClusterFlow(c, specialists);
    const e = flow.edges[0];
    expect(e.source).toBe("a");
    expect(e.target).toBe("b");
    expect(e.sourceHandle).toBe("rs");
    expect(e.targetHandle).toBe("lt");
    expect(e.type).toBe("custom");
  });

  it("same-column parent-child edges route via left handles (detour-left)", () => {
    const c = cluster(
      [node("epic"), node("child")],
      [{ from: "child", to: "epic", type: "parent-child" }],
    );
    const flow = buildClusterFlow(c, specialists);
    const e = flow.edges[0];
    expect(e.sourceHandle).toBe("ls");
    expect(e.targetHandle).toBe("lt");
  });

  it("renders all 9 GraphEdgeType values without filtering by type", () => {
    const ns = [node("a"), node("b")];
    const types = ["blocks", "tracks", "related", "parent-child", "discovered-from", "validates", "caused-by", "until", "supersedes"] as const;
    const edges = types.map((type) => ({ from: "a", to: "b", type }));
    const flow = buildClusterFlow(cluster(ns, edges), specialists);
    expect(flow.edges).toHaveLength(9);
    expect(new Set(flow.edges.map((e) => e.data?.edgeType))).toEqual(new Set(types));
  });

  it("attaches specialist to its bead node's data payload", () => {
    const spec: GraphSpecialist = { bead_id: "a", job_id: "abc123", role: "executor", status: "running", updated_at: "2026-05-20T00:00:00Z" };
    const map = new Map([["a", spec]]);
    const flow = buildClusterFlow(cluster([node("a"), node("b")], []), map);
    const a = flow.nodes.find((n) => n.id === "a");
    expect(a?.data.specialist).toBe(spec);
    const b = flow.nodes.find((n) => n.id === "b");
    expect(b?.data.specialist).toBeNull();
  });

  it("returns positive width/height covering the laid-out nodes", () => {
    const c = cluster(
      [node("a"), node("b"), node("c")],
      [{ from: "a", to: "b", type: "blocks" }, { from: "b", to: "c", type: "blocks" }],
    );
    const flow = buildClusterFlow(c, specialists);
    expect(flow.width).toBeGreaterThan(0);
    expect(flow.height).toBeGreaterThan(0);
  });
});
