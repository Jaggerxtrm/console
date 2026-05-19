import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../../../../src/dashboard/pages/console/graph/layout.ts";
import type { GraphEdge, GraphNode } from "../../../../../src/dashboard/pages/console/graph/types.ts";

const nodes: GraphNode[] = [
  { id: "a", title: "Alpha", type: "task", priority: 1, status: "open", assignee: null, closed_at: null, superseded_by: null },
  { id: "b", title: "Beta", type: "task", priority: 1, status: "closed", assignee: null, closed_at: "2026-01-01", superseded_by: null },
  { id: "c", title: "Gamma", type: "epic", priority: 0, status: "blocked", assignee: null, closed_at: null, superseded_by: "d" },
  { id: "d", title: "Delta", type: "feature", priority: 2, status: "in_progress", assignee: null, closed_at: null, superseded_by: null },
  { id: "e", title: "Epsilon", type: "bug", priority: 3, status: "open", assignee: null, closed_at: null, superseded_by: null },
];

const edges: GraphEdge[] = [
  { from: "a", to: "d", type: "blocks" },
  { from: "a", to: "d", type: "tracks" },
  { from: "b", to: "c", type: "related" },
  { from: "c", to: "e", type: "supersedes" },
  { from: "a", to: "e", type: "parent-child" },
];

describe("layoutGraph", () => {
  it("assigns weighted layers left-to-right", () => {
    const layout = layoutGraph(nodes, edges);
    const xById = new Map(layout.nodes.map((node) => [node.id, node.x]));
    expect(xById.get("a") ?? 0).toBeLessThan(xById.get("d") ?? 0);
    expect(xById.get("a") ?? 0).toBeLessThan(xById.get("e") ?? 0);
  });

  it("keeps multi-edges separate with top and bottom routes", () => {
    const layout = layoutGraph(nodes, edges);
    const pair = layout.edges.filter((edge) => edge.from === "a" && edge.to === "d");
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((edge) => edge.routed))).toEqual(new Set(["top", "bottom"]));
  });

  it("preserves closed and superseded nodes", () => {
    const layout = layoutGraph(nodes, edges);
    const b = layout.nodes.find((node) => node.id === "b");
    const c = layout.nodes.find((node) => node.id === "c");
    expect(b?.status).toBe("closed");
    expect(c?.superseded_by).toBe("d");
  });

  it("uses weights to keep lighter edges from forcing layers", () => {
    const layout = layoutGraph(nodes, edges);
    const a = layout.nodes.find((node) => node.id === "a");
    const b = layout.nodes.find((node) => node.id === "b");
    expect((b?.x ?? 0) - (a?.x ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
