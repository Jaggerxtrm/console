import type { ChainSummary } from "../../../hooks/useChains.ts";
import type { GraphEdge, GraphEdgeType, GraphNode, GraphResponse } from "../../../../types/graph.ts";

export interface ChainRelatedIssue {
  node: GraphNode;
  edge: GraphEdge;
  direction: "incoming" | "outgoing" | "internal";
}

export interface ChainIssueContext {
  touched: GraphNode[];
  related: ChainRelatedIssue[];
}

export const RELATIONSHIP_LABEL: Record<GraphEdgeType, string> = {
  blocks: "blocks",
  tracks: "tracks",
  related: "related",
  "parent-child": "parent",
  "discovered-from": "discovered from",
  validates: "validates",
  "caused-by": "caused by",
  until: "until",
  supersedes: "supersedes",
};

export function buildChainIssueContext(chain: ChainSummary, graph: GraphResponse | null | undefined): ChainIssueContext {
  if (!graph) return { touched: [], related: [] };
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const touchedIds = new Set([chain.rootBeadId, ...chain.jobs.map((job) => job.beadId)]);
  const touched = [...touchedIds].map((id) => nodeById.get(id)).filter((node): node is GraphNode => Boolean(node));
  const relatedByKey = new Map<string, ChainRelatedIssue>();

  for (const edge of graph.edges) {
    const fromTouched = touchedIds.has(edge.from);
    const toTouched = touchedIds.has(edge.to);
    if (!fromTouched && !toTouched) continue;

    if (fromTouched && toTouched) continue;

    const relatedId = fromTouched ? edge.to : edge.from;
    const node = nodeById.get(relatedId);
    if (!node) continue;
    relatedByKey.set(`${edge.type}:${fromTouched ? "out" : "in"}:${node.id}`, {
      node,
      edge,
      direction: fromTouched ? "outgoing" : "incoming",
    });
  }

  return {
    touched,
    related: [...relatedByKey.values()].sort((left, right) => sortGraphNodes(left.node, right.node)),
  };
}

function sortGraphNodes(left: GraphNode, right: GraphNode): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.status !== right.status) return left.status.localeCompare(right.status);
  return left.id.localeCompare(right.id);
}
