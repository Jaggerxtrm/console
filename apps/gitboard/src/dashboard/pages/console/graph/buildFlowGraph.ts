// Per-cluster React Flow builder. Each cluster gets its own bounded viewport
// (mounted by ClusterPane in Graph.tsx) — no parent/child node containers.
// Dagre runs LR over structural edges; non-structural edges (parent-child,
// related, tracks, until) ride along on top.
//
// Edge handles are picked by relative position so edges never wrap back over
// the source chip — each BeadNode exposes 4 handles (left/right · source/target).

import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { GraphEdge, GraphSpecialist } from "../../../../types/graph.ts";
import { STRUCTURAL_EDGE_TYPES, type ClusterGroup } from "./clusters.ts";
import type { BeadNodeData } from "./nodes/BeadNode.tsx";
import type { CustomEdgeData } from "./edges/CustomEdge.tsx";

export const NODE_W = 260;
export const NODE_H = 44;
const PAD = 18;

export type ClusterFlowNode = Node<BeadNodeData, "beadNode">;
export type ClusterFlowEdge = Edge<CustomEdgeData>;

export interface ClusterFlow {
  nodes: ClusterFlowNode[];
  edges: ClusterFlowEdge[];
  /** Natural width of the laid-out cluster (used to size the pane viewport). */
  width: number;
  /** Natural height of the laid-out cluster. */
  height: number;
}

export function buildClusterFlow(
  cluster: ClusterGroup,
  specialists: Map<string, GraphSpecialist>,
): ClusterFlow {
  // 1. Dagre LR over structural edges only.
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 10, ranksep: 80, marginx: 0, marginy: 0 });
  for (const n of cluster.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of cluster.edges) {
    if (!STRUCTURAL_EDGE_TYPES.has(e.type)) continue;
    g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  // 2. Normalize coords.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const posByNode = new Map<string, { x: number; y: number }>();
  for (const n of cluster.nodes) {
    const pos = g.node(n.id);
    if (!pos) continue;
    const x = pos.x - NODE_W / 2;
    const y = pos.y - NODE_H / 2;
    posByNode.set(n.id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = NODE_W; maxY = NODE_H; }
  const offX = -minX + PAD;
  const offY = -minY + PAD;

  // 3. Emit nodes.
  const nodes: ClusterFlowNode[] = cluster.nodes.map((n) => {
    const pos = posByNode.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: "beadNode",
      position: { x: pos.x + offX, y: pos.y + offY },
      data: { node: n, specialist: specialists.get(n.id) ?? null },
      draggable: false,
      selectable: false,
    };
  });

  // 4. Emit edges with handle pairs picked from relative positions.
  const edges: ClusterFlowEdge[] = cluster.edges.map((e, i) => buildEdge(e, i, posByNode));

  return {
    nodes,
    edges,
    width: (maxX - minX) + 2 * PAD,
    height: (maxY - minY) + 2 * PAD,
  };
}

function buildEdge(
  e: GraphEdge,
  idx: number,
  pos: Map<string, { x: number; y: number }>,
): ClusterFlowEdge {
  const from = pos.get(e.from);
  const to = pos.get(e.to);
  const { sourceHandle, targetHandle } = pickHandles(from, to);
  return {
    id: `${e.from}::${e.to}::${e.type}::${idx}`,
    source: e.from,
    target: e.to,
    sourceHandle,
    targetHandle,
    type: "custom",
    data: { edgeType: e.type },
    zIndex: 1,
  };
}

// Pick handle pair so the bezier never wraps back over — or cuts through — a
// chip. Same-column edges (siblings → shared epic, etc.) detour via the LEFT
// margin: both handles on the left side push their control points outward, so
// the curve bulges around the chip stack instead of slicing through it.
//   forward   (target clearly right of source)  : right → left
//   reverse   (target clearly left of source)   : left → right
//   same col  (Δx ≈ 0)                          : left → left (detour left)
// Returned handle ids match BeadNode's <Handle id="..."> entries.
function pickHandles(
  from: { x: number; y: number } | undefined,
  to: { x: number; y: number } | undefined,
): { sourceHandle: string; targetHandle: string } {
  if (!from || !to) return { sourceHandle: "rs", targetHandle: "lt" };
  const dx = to.x - from.x;
  const SAME_COL_TOL = NODE_W * 0.5;
  if (Math.abs(dx) < SAME_COL_TOL) {
    return { sourceHandle: "ls", targetHandle: "lt" };
  }
  if (dx > 0) return { sourceHandle: "rs", targetHandle: "lt" };
  return { sourceHandle: "ls", targetHandle: "rt" };
}
