// Final BeadNode for the React Flow viewport. JSX mirrors the .g-node chip from
// the legacy renderer; position:relative override is required because the legacy
// .g-node CSS sets position:absolute (for the SVG-based renderer) which would
// fight React Flow's wrapper.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode, GraphSpecialist } from "../../../../../types/graph.ts";
import { categoryFor, shortJobId, type AgentCategory } from "../agent-roles.ts";

export interface BeadNodeData extends Record<string, unknown> {
  node: GraphNode;
  specialist: GraphSpecialist | null;
}

const HANDLE_STYLE = { opacity: 0, pointerEvents: "none" as const, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, background: "transparent" };

export function BeadNode({ data }: NodeProps) {
  const { node, specialist } = data as BeadNodeData;
  const isRunning = specialist?.status === "running";
  const isBlocked = node.status === "blocked";
  const isEpic = node.type === "epic";
  const agentCat: AgentCategory = categoryFor(specialist?.role);
  const classes = [
    "g-node",
    isBlocked ? "blkd" : "",
    isRunning ? "act" : "",
    isEpic ? "ep" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} data-p={node.priority} style={{ width: 220, position: "relative" }}>
      <Handle id="lt" type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="ls" type="source" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="tt" type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle id="ts" type="source" position={Position.Top} style={HANDLE_STYLE} />
      <Handle id="bt" type="target" position={Position.Bottom} style={HANDLE_STYLE} />
      <Handle id="bs" type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <span className={`g-glyph ${glyphClass(node)}`}>{glyphChar(node)}</span>
      <span className="g-id">
        {idPrefix(node.id)}<b>{idSuffix(node.id)}</b>
      </span>
      <span className="g-tt">{node.title}</span>
      {specialist ? (
        <span className={`g-ag ${agentCat}`}>
          <span className="g-ag-dot" />
          <b>{specialist.role}</b>/{shortJobId(specialist.job_id)}
        </span>
      ) : null}
      <span className={`g-tag p${node.priority}`}>P{node.priority}</span>
      <Handle id="rt" type="target" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="rs" type="source" position={Position.Right} style={HANDLE_STYLE} />
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
