// SPIKE (forge-2a8a.1) — throwaway. Deleted in forge-2a8a.4 cleanup.
// Custom React Flow node that visually matches the existing .g-node chip.
// JSX ported straight from ClusterNode in ../console/Graph.tsx; only difference
// is positioning is owned by React Flow (no absolute left/top here) and we add
// two <Handle> components so edges have anchors.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "../../../types/graph.ts";

export interface BeadNodeData extends Record<string, unknown> {
  node: GraphNode;
}

export function BeadNode({ data }: NodeProps) {
  const { node } = data as BeadNodeData;
  const isBlocked = node.status === "blocked";
  const isEpic = node.type === "epic";
  const classes = [
    "g-node",
    isBlocked ? "blkd" : "",
    isEpic ? "ep" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} data-p={node.priority} style={{ width: 220 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <span className={`g-glyph ${glyphClass(node)}`}>{glyphChar(node)}</span>
      <span className="g-id">
        {idPrefix(node.id)}<b>{idSuffix(node.id)}</b>
      </span>
      <span className="g-tt">{node.title}</span>
      <span className={`g-tag p${node.priority}`}>P{node.priority}</span>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function glyphChar(node: GraphNode): string {
  if (node.superseded_by) return "✕";
  if (node.type === "epic") return "◈";
  return ({ open: "◯", in_progress: "◐", blocked: "◇", closed: "✓", deferred: "◇" } as Record<string, string>)[node.status] ?? "◯";
}
function glyphClass(node: GraphNode): string {
  if (node.superseded_by) return "c";
  if (node.type === "epic") return "e";
  return ({ open: "r", in_progress: "w", blocked: "b", closed: "c", deferred: "gt" } as Record<string, string>)[node.status] ?? "r";
}
function idPrefix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(0, i + 1) : ""; }
function idSuffix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(i + 1) : id; }
