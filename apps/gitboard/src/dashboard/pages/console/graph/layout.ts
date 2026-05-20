// Layered LR layout per docs/graph/detail.md.
//
// Layering rule: topological depth computed *only over `blocks` edges* — that's the
// single relationship that constrains the scheduler. L0 = no incoming blocks (pickable),
// L1 = blocked by L0, etc. All other edge types render but never force layer changes,
// so the column position stays semantically meaningful: left = ready, right = waiting.
//
// Layer ordering within a column: nodes sorted by (priority asc, id asc) — high priority
// first. If a layer has more than MAX_LAYER_ROWS nodes, it wraps into multiple sub-columns
// so a 16-bead L0 stack doesn't run off the viewport.
//
// Edge points are emitted as [start, control1, control2, end] for cubic-bezier rendering
// in GraphSvg. Same-pair multi-edges arc top + bottom (never merged) per detail.md.

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

// Legacy export — kept for the layout test that imports it. Layering ignores these now
// (per spec only blocks counts); kept to avoid breaking the test signature.
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

// Compact single-row node (per operator feedback): id + P-tag + agent inline, no title.
// 220x26 keeps the cell tight like an IssueFeed row.
const NODE_W = 220;
const NODE_H = 26;
const COL_GAP = 110;
const ROW_GAP = 8;
const MAX_LAYER_ROWS = 14;
const SUB_COL_GAP = 28;

const ROW_STEP = NODE_H + ROW_GAP;

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], nodeWidths?: Map<string, number>): LayoutResult {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const widthOf = (id: string) => nodeWidths?.get(id) ?? NODE_W;

  // 1) layering — blocks edges only
  const blocksOutgoing = new Map<string, string[]>();
  const blocksIncoming = new Map<string, string[]>();
  for (const node of nodes) {
    blocksOutgoing.set(node.id, []);
    blocksIncoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (edge.type !== "blocks") continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    blocksOutgoing.get(edge.from)!.push(edge.to);
    blocksIncoming.get(edge.to)!.push(edge.from);
  }

  const indegree = new Map(nodes.map((node) => [node.id, blocksIncoming.get(node.id)!.length]));
  const queue: string[] = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]));

  while (queue.length > 0) {
    const id = queue.shift()!;
    const next = (layer.get(id) ?? 0) + 1;
    for (const to of blocksOutgoing.get(id) ?? []) {
      if ((layer.get(to) ?? 0) < next) layer.set(to, next);
      const remaining = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, remaining);
      if (remaining === 0) queue.push(to);
    }
  }

  // 2) bucket per layer
  const layers = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const bucket = layer.get(node.id) ?? 0;
    if (!layers.has(bucket)) layers.set(bucket, []);
    layers.get(bucket)!.push(node);
  }

  // 3) sort within layer: priority asc (P0 first), then id
  for (const [bucket, group] of layers) {
    group.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
    layers.set(bucket, group);
  }

  // 4) position. Wrap large layers into sub-columns. Track per-layer width.
  const positioned = new Map<string, LayoutNode>();
  const sortedBuckets = [...layers.entries()].sort((a, b) => a[0] - b[0]);

  let xCursor = 0;
  for (const [bucket, group] of sortedBuckets) {
    const subCols = Math.max(1, Math.ceil(group.length / MAX_LAYER_ROWS));
    const rowsPerCol = Math.ceil(group.length / subCols);
    // sub-column x positions use the widest node in that sub-column
    const subColMax: number[] = Array(subCols).fill(0);
    group.forEach((node, index) => {
      const subColIndex = Math.floor(index / rowsPerCol);
      subColMax[subColIndex] = Math.max(subColMax[subColIndex], widthOf(node.id));
    });
    const subColX: number[] = Array(subCols).fill(0);
    for (let i = 1; i < subCols; i++) subColX[i] = subColX[i - 1] + subColMax[i - 1] + SUB_COL_GAP;
    const layerWidth = subColX[subCols - 1] + subColMax[subCols - 1];
    const totalRowsHeight = rowsPerCol * NODE_H + Math.max(0, rowsPerCol - 1) * ROW_GAP;
    const startY = -totalRowsHeight / 2;

    group.forEach((node, index) => {
      const subColIndex = Math.floor(index / rowsPerCol);
      const rowIndex = index % rowsPerCol;
      const nx = xCursor + subColX[subColIndex];
      const ny = startY + rowIndex * ROW_STEP;
      positioned.set(node.id, { ...node, x: nx, y: ny, layer: bucket, order: index });
    });

    xCursor += layerWidth + COL_GAP;
  }

  // 5) anchor distribution + routing
  // Count outgoing edges per source and incoming edges per target so we can give each
  // edge its own slot along the node's right/left edge — no more all-emerging-from-one-point.
  const outgoingByNode = new Map<string, Array<{ to: string; type: string; key: string }>>();
  const incomingByNode = new Map<string, Array<{ from: string; type: string; key: string }>>();
  for (const edge of edges) {
    if (!positioned.has(edge.from) || !positioned.has(edge.to)) continue;
    const key = `${edge.from}::${edge.to}::${edge.type}`;
    const outArr = outgoingByNode.get(edge.from) ?? [];
    outArr.push({ to: edge.to, type: edge.type, key });
    outgoingByNode.set(edge.from, outArr);
    const inArr = incomingByNode.get(edge.to) ?? [];
    inArr.push({ from: edge.from, type: edge.type, key });
    incomingByNode.set(edge.to, inArr);
  }
  // Sort each node's adjacency by the OTHER endpoint's vertical position so the slots
  // are issued top-to-bottom in the order they actually reach.
  for (const [src, arr] of outgoingByNode) {
    arr.sort((a, b) => (positioned.get(a.to)!.y - positioned.get(b.to)!.y) || a.to.localeCompare(b.to));
    outgoingByNode.set(src, arr);
  }
  for (const [tgt, arr] of incomingByNode) {
    arr.sort((a, b) => (positioned.get(a.from)!.y - positioned.get(b.from)!.y) || a.from.localeCompare(b.from));
    incomingByNode.set(tgt, arr);
  }

  // Build slot index per edge key for both sides.
  const outSlot = new Map<string, number>();
  const inSlot = new Map<string, number>();
  for (const [, arr] of outgoingByNode) arr.forEach((e, i) => outSlot.set(e.key, i));
  for (const [, arr] of incomingByNode) arr.forEach((e, i) => inSlot.set(e.key, i));

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
    const pairKey = `${edge.from}::${edge.to}`;
    const edgeKey = `${edge.from}::${edge.to}::${edge.type}`;
    const idx = pairIndex.get(pairKey) ?? 0;
    pairIndex.set(pairKey, idx + 1);
    const total = pairCounts.get(pairKey) ?? 1;
    const routedKind: LayoutEdge["routed"] = total > 1 ? (idx % 2 === 0 ? "top" : "bottom") : "straight";
    const fromAnchorY = anchorY(from, outSlot.get(edgeKey) ?? 0, outgoingByNode.get(edge.from)?.length ?? 1);
    const toAnchorY = anchorY(to, inSlot.get(edgeKey) ?? 0, incomingByNode.get(edge.to)?.length ?? 1);
    return [{
      ...edge,
      routed: routedKind,
      points: routeEdge(from, to, routedKind, idx, widthOf(from.id), widthOf(to.id), fromAnchorY, toAnchorY),
    }];
  });

  // 6) normalize coords so everything is positive with a margin
  const PAD = 40;
  const allNodes = [...positioned.values()];
  const minX = Math.min(...allNodes.map((n) => n.x));
  const minY = Math.min(...allNodes.map((n) => n.y));
  const offX = -minX + PAD;
  const offY = -minY + PAD;

  const normalizedNodes = allNodes
    .map((node) => ({ ...node, x: node.x + offX, y: node.y + offY }))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  const normalizedEdges = routed.map((edge) => ({
    ...edge,
    points: edge.points.map((p) => ({ x: p.x + offX, y: p.y + offY })),
  }));

  const width = Math.max(...normalizedNodes.map((n) => n.x + widthOf(n.id))) + PAD;
  const height = Math.max(...normalizedNodes.map((n) => n.y + NODE_H)) + PAD;

  return { width, height, nodes: normalizedNodes, edges: normalizedEdges };
}

// Distribute multiple edges along the source's right edge / target's left edge so they
// never all share one anchor point. Slot 0 sits near the top of the row, last slot at
// the bottom, single-edge cases stay centered.
function anchorY(node: LayoutNode, slot: number, total: number): number {
  if (total <= 1) return node.y + NODE_H / 2;
  // Reserve 4px insets so anchors don't sit exactly at row corners.
  const top = node.y + 4;
  const bot = node.y + NODE_H - 4;
  const step = (bot - top) / (total - 1);
  return top + slot * step;
}

// Emits 4 points: [start, control1, control2, end] for a cubic bezier.
//
// Three routing modes:
// - FORWARD (to.layer > from.layer): standard left-to-right curve. Path leaves source's
//   right edge, arrives at target's LEFT edge. Arrowhead points right into the card.
// - SAME-LAYER (to.layer === from.layer): right-side detour. Path leaves source's right
//   edge, swoops right, returns to target's RIGHT edge. Arrowhead points left into the card.
// - REVERSE (to.layer < from.layer): same as same-layer detour — go around the right,
//   land on target's RIGHT edge. Prevents arrowheads "floating" past the target's left
//   edge when the path crosses the canvas leftward.
function routeEdge(
  from: LayoutNode,
  to: LayoutNode,
  routed: "straight" | "top" | "bottom",
  idx: number,
  fromWidth: number,
  toWidth: number,
  fromAnchorY: number,
  toAnchorY: number,
) {
  const forward = to.layer > from.layer;
  const sx = from.x + fromWidth;
  const sy = fromAnchorY;
  const ty = toAnchorY;

  if (!forward) {
    // Same-layer or reverse — detour around the right side and land on target's RIGHT edge.
    const detour = 36 + idx * 6;
    const sxOut = sx;
    const txIn = to.x + toWidth;
    const arcSide = routed === "top" ? -1 : 1;
    return [
      { x: sxOut, y: sy },
      { x: sxOut + detour, y: sy + arcSide * 10 },
      { x: txIn + detour, y: ty + arcSide * 10 },
      { x: txIn, y: ty },
    ];
  }

  // Forward curve — leave source horizontally, arrive at target's LEFT edge horizontally.
  const tx = to.x;
  const dx = Math.max(40, (tx - sx) / 2);
  const arcSide = routed === "top" ? -1 : routed === "bottom" ? 1 : 0;
  const bend = arcSide * (10 + idx * 6);
  return [
    { x: sx, y: sy },
    { x: sx + dx, y: sy + bend },
    { x: tx - dx, y: ty + bend },
    { x: tx, y: ty },
  ];
}
