// Structural pass over the raw graph data per operator spec:
//   1. Filter into buckets (closed / superseded / deferred-P3+).
//   2. Compute connected components on the remaining active set (any edge type).
//   3. Sort components by P0-presence, then node count, then edge count.
//   4. 1-node components → orphan list.
//   5. Name each component (epic id, longest blocks-chain endpoints, or +N fallback).
//
// Pure logic — no React, no DOM. Consumed by Graph.tsx which renders each cluster in
// its own bounded pane.

import type { GraphEdge, GraphNode, GraphResponse, GraphSpecialist } from "../../../../types/graph.ts";

export interface ClusterGroup {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hasP0: boolean;
  hasRunning: boolean;
}

export interface BucketGroup {
  closed: GraphNode[];
  superseded: GraphNode[];
  deferred: GraphNode[];
}

export interface PartitionedGraph {
  wip: GraphNode[];          // in_progress AND any node with a running specialist
  clusters: ClusterGroup[];  // ≥2-node connected components, sorted by importance
  orphans: GraphNode[];      // 1-node components (no edges), sorted by priority+age
  buckets: BucketGroup;      // closed / superseded / deferred-P3+ (hidden by default)
}

/** Which edge types contribute to component connectivity & visible drawing. */
export const STRUCTURAL_EDGE_TYPES = new Set([
  "blocks",
  "caused-by",
  "validates",
  "supersedes",
  "discovered-from",
  "tracks",
  "until",
]);

/** Edge types that exist in the data but don't drive layout / connectivity by default. */
export const NOISE_EDGE_TYPES = new Set(["parent-child", "related"]);

export interface PartitionOptions {
  includeParentChild?: boolean;  // include `parent-child` edges in connectivity + drawing
  includeRelated?: boolean;      // include `related` edges in connectivity + drawing
  /** @deprecated use includeParentChild + includeRelated */
  includeNoiseEdges?: boolean;
  revealDeferred?: boolean;      // toggle to lift the deferred bucket back into the graph
}

export function partitionGraph(
  data: GraphResponse,
  specialists: Map<string, GraphSpecialist>,
  options: PartitionOptions = {},
): PartitionedGraph {
  const {
    includeParentChild = options.includeNoiseEdges ?? false,
    includeRelated = options.includeNoiseEdges ?? false,
    revealDeferred = false,
  } = options;

  // ---- step 1: filter into buckets ----
  const buckets: BucketGroup = { closed: [], superseded: [], deferred: [] };
  const active: GraphNode[] = [];
  for (const node of data.nodes) {
    if (node.superseded_by) { buckets.superseded.push(node); continue; }
    if (node.status === "closed") { buckets.closed.push(node); continue; }
    // P3+ deferred → bucket unless operator explicitly reveals
    if (!revealDeferred && (node.status === "deferred" || node.priority >= 3)) {
      buckets.deferred.push(node);
      continue;
    }
    active.push(node);
  }

  // ---- step 2: connected components on active set ----
  const activeIds = new Set(active.map((n) => n.id));
  const edgesByType = data.edges.filter((e) => {
    if (STRUCTURAL_EDGE_TYPES.has(e.type)) return true;
    if (e.type === "parent-child") return includeParentChild;
    if (e.type === "related") return includeRelated;
    return false;
  });
  const activeEdges = edgesByType.filter((e) => activeIds.has(e.from) && activeIds.has(e.to));

  // Union-Find
  const parent = new Map<string, string>();
  for (const id of activeIds) parent.set(id, id);
  const find = (id: string): string => {
    let p = parent.get(id) ?? id;
    while (p !== parent.get(p)) p = parent.get(p)!;
    // path compression
    let cur = id;
    while (parent.get(cur) !== p) {
      const nxt = parent.get(cur)!;
      parent.set(cur, p);
      cur = nxt;
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of activeEdges) union(e.from, e.to);

  // ---- step 3: group nodes by component root ----
  const componentMap = new Map<string, { nodes: GraphNode[]; edges: GraphEdge[] }>();
  for (const node of active) {
    const root = find(node.id);
    if (!componentMap.has(root)) componentMap.set(root, { nodes: [], edges: [] });
    componentMap.get(root)!.nodes.push(node);
  }
  for (const e of activeEdges) {
    const root = find(e.from);
    componentMap.get(root)?.edges.push(e);
  }

  // ---- step 4: split single-node components into orphans ----
  const orphans: GraphNode[] = [];
  const clustersRaw: ClusterGroup[] = [];
  for (const [root, comp] of componentMap) {
    if (comp.nodes.length === 1) {
      orphans.push(comp.nodes[0]);
      continue;
    }
    const hasP0 = comp.nodes.some((n) => n.priority === 0);
    const hasRunning = comp.nodes.some((n) => specialists.get(n.id)?.status === "running");
    clustersRaw.push({
      id: root,
      name: nameCluster(comp.nodes, comp.edges),
      nodes: comp.nodes,
      edges: comp.edges,
      hasP0,
      hasRunning,
    });
  }

  // ---- step 5: sort clusters by importance ----
  clustersRaw.sort((a, b) => {
    // P0-bearing first
    if (a.hasP0 !== b.hasP0) return a.hasP0 ? -1 : 1;
    // Running first
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1;
    // Larger node count first
    if (a.nodes.length !== b.nodes.length) return b.nodes.length - a.nodes.length;
    // Then more edges
    if (a.edges.length !== b.edges.length) return b.edges.length - a.edges.length;
    return a.id.localeCompare(b.id);
  });

  // Sort orphans: priority asc (P0 first), then id (stable)
  orphans.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));

  // ---- step 6: WIP set ----
  const wipIds = new Set<string>();
  for (const n of active) {
    if (n.status === "in_progress") wipIds.add(n.id);
    if (specialists.get(n.id)?.status === "running") wipIds.add(n.id);
  }
  const wip = active.filter((n) => wipIds.has(n.id));

  return { wip, clusters: clustersRaw, orphans, buckets };
}

/**
 * Cluster naming heuristic (per operator spec):
 *   1. If every node shares a `parent-child` edge to one epic → that epic id + count.
 *   2. Else: find the longest `blocks` chain inside the cluster, name it endpoint → endpoint.
 *   3. Fallback: "+N nodes".
 */
function nameCluster(nodes: GraphNode[], edges: GraphEdge[]): string {
  // (1) epic name — does every node have a parent-child edge pointing at the same epic?
  const epicCandidates = new Map<string, number>();
  for (const e of edges) {
    if (e.type === "parent-child") {
      epicCandidates.set(e.to, (epicCandidates.get(e.to) ?? 0) + 1);
      epicCandidates.set(e.from, (epicCandidates.get(e.from) ?? 0) + 1);
    }
  }
  for (const [candidate, count] of epicCandidates) {
    const node = nodes.find((n) => n.id === candidate);
    if (node?.type === "epic" && count >= nodes.length - 1) {
      return `${candidate} · ${nodes.length} nodes`;
    }
  }

  // (2) longest blocks chain endpoints
  const blocksEdges = edges.filter((e) => e.type === "blocks");
  if (blocksEdges.length > 0) {
    const chain = longestChain(blocksEdges, nodes.map((n) => n.id));
    if (chain && chain.length >= 2) {
      return `${chain[0]} → ${chain[chain.length - 1]} · ${nodes.length} nodes`;
    }
  }

  // (3) fallback
  return `${nodes.length} nodes`;
}

function longestChain(edges: GraphEdge[], allIds: string[]): string[] | null {
  // Topological-ish DP over the blocks-only DAG inside the cluster.
  const next = new Map<string, string[]>();
  const indeg = new Map<string, number>(allIds.map((id) => [id, 0]));
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // Best-so-far chain ending at each node
  const best = new Map<string, string[]>();
  const queue: string[] = allIds.filter((id) => indeg.get(id) === 0);
  for (const id of queue) best.set(id, [id]);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const to of next.get(id) ?? []) {
      const remaining = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, remaining);
      if (remaining === 0) queue.push(to);
    }
  }
  for (const id of order) {
    for (const to of next.get(id) ?? []) {
      const candidate = [...(best.get(id) ?? []), to];
      const existing = best.get(to);
      if (!existing || candidate.length > existing.length) best.set(to, candidate);
    }
  }
  let longest: string[] = [];
  for (const chain of best.values()) if (chain.length > longest.length) longest = chain;
  return longest.length >= 2 ? longest : null;
}
