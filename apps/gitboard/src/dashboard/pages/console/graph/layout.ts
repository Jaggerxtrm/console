// Weighted layered LR layout. Edge weights: blocks=5, supersedes=3, parent-child=0.5, discovered-from=2, validates=2, caused-by=2, tracks=1, until=1, related=0.2.

import type { GraphEdge, GraphEdgeType, GraphNode } from "../../../../types/graph.ts";

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  layer: number;
  order: number;
}

export interface LayoutEdge extends GraphEdge {
  points: Array<{ x: number; y: number }>;
  routed: "straight" | "top" | "bottom";
}

export interface LayoutResult {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export const EDGE_WEIGHTS: Record<GraphEdgeType, number> = {
  blocks: 5,
  supersedes: 3,
  "parent-child": 0.5,
  "discovered-from": 2,
  validates: 2,
  "caused-by": 2,
  tracks: 1,
  until: 1,
  related: 0.2,
};

const NODE_W = 240;
const NODE_H = 52;
const COL_GAP = 180;
const ROW_GAP = 20;

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Array<{ from: string; weight: number }>>();
  const outgoing = new Map<string, Array<{ to: string; weight: number }>>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    const weight = EDGE_WEIGHTS[edge.type];
    incoming.get(edge.to)?.push({ from: edge.from, weight });
    outgoing.get(edge.from)?.push({ to: edge.to, weight });
  }

  const indegree = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]));

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const nextLayer = layer.get(id) ?? 0;
    for (const edge of outgoing.get(id) ?? []) {
      const step = edge.weight >= 1 ? 1 : 0;
      layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, nextLayer + step));
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) - 1);
      if ((indegree.get(edge.to) ?? 0) === 0) queue.push(edge.to);
    }
  }

  const layers = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const bucket = layer.get(node.id) ?? 0;
    if (!layers.has(bucket)) layers.set(bucket, []);
    layers.get(bucket)!.push(node);
  }

  for (const [bucket, group] of layers) {
    group.sort((a, b) => {
      const aScore = scoreNode(a.id, incoming, layer);
      const bScore = scoreNode(b.id, incoming, layer);
      if (aScore !== bScore) return aScore - bScore;
      return a.id.localeCompare(b.id);
    });
    layers.set(bucket, group);
  }

  const positioned = new Map<string, LayoutNode>();
  let maxWidth = 0;
  for (const [bucket, group] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const x = bucket * COL_GAP;
    maxWidth = Math.max(maxWidth, x);
    const totalHeight = group.length * NODE_H + Math.max(0, group.length - 1) * ROW_GAP;
    const startY = -totalHeight / 2;
    group.forEach((node, index) => {
      positioned.set(node.id, { ...node, x, y: startY + index * (NODE_H + ROW_GAP), layer: bucket, order: index });
    });
  }

  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    if (!positioned.has(edge.from) || !positioned.has(edge.to)) continue;
    const key = `${edge.from}::${edge.to}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const pairIndex = new Map<string, number>();
  const routed = edges.flatMap((edge) => {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (!from || !to) return [] as LayoutEdge[];
    const key = `${edge.from}::${edge.to}`;
    const index = pairIndex.get(key) ?? 0;
    pairIndex.set(key, index + 1);
    const total = pairCounts.get(key) ?? 1;
    const routedKind: LayoutEdge["routed"] = total > 1 ? (index % 2 === 0 ? "top" : "bottom") : "straight";
    return [{ ...edge, routed: routedKind, points: routeEdge(from, to, routedKind, index, total) }];
  });

  const sortedNodes = [...positioned.values()].sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  const minY = Math.min(...sortedNodes.map((n) => n.y));
  const maxY = Math.max(...sortedNodes.map((n) => n.y + NODE_H));
  const height = maxY - minY + NODE_H;
  const normalizedNodes = sortedNodes.map((node) => ({ ...node, y: node.y - minY + NODE_H }));
  const normalizedEdges = routed.map((edge) => ({ ...edge, points: edge.points.map((p) => ({ x: p.x + NODE_W / 2 + 20, y: p.y - minY + NODE_H / 2 })) }));

  return {
    width: maxWidth + NODE_W + 120,
    height: height + 80,
    nodes: normalizedNodes,
    edges: normalizedEdges,
  };
}

function scoreNode(id: string, incoming: Map<string, Array<{ from: string; weight: number }>>, layer: Map<string, number>): number {
  const entries = incoming.get(id) ?? [];
  if (entries.length === 0) return layer.get(id) ?? 0;
  return entries.reduce((sum, edge) => sum + (layer.get(edge.from) ?? 0) + edge.weight, 0) / entries.length;
}

function routeEdge(from: LayoutNode, to: LayoutNode, routed: "straight" | "top" | "bottom", index: number, total: number) {
  const startX = from.x + NODE_W;
  const startY = from.y + NODE_H / 2;
  const endX = to.x;
  const endY = to.y + NODE_H / 2;
  const dx = Math.max(70, (endX - startX) / 2);
  const bend = routed === "straight" ? 0 : (routed === "top" ? -1 : 1) * (18 + index * 6 + total * 2);
  const midX1 = startX + dx;
  const midX2 = endX - dx;
  return [
    { x: startX, y: startY },
    { x: midX1, y: startY + bend },
    { x: midX2, y: endY + bend },
    { x: endX, y: endY },
  ];
}
