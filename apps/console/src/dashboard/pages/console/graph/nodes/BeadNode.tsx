// BeadNode — visual register matches IssueFeed rows (forge-2a8a follow-up):
// identity row (id / title) on top, classification row (Pn · type · state · agent)
// on bottom. No priority left rail — Feed has none. Type-coloured Pn + type
// label using the same palette as TYPE_CONFIG in IssueFeed.tsx.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode, GraphNodeType, GraphSpecialist } from "../../../../../types/graph.ts";
import { TYPE_CONFIG } from "../../../../lib/type-palette.ts";
import { categoryFor, shortJobId, type AgentCategory } from "../agent-roles.ts";

export interface BeadNodeData extends Record<string, unknown> {
  node: GraphNode;
  specialist: GraphSpecialist | null;
}

const HANDLE_STYLE = {
  opacity: 0,
  pointerEvents: "none" as const,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 0,
  background: "transparent",
};

const TYPE_COLOR: Record<GraphNodeType, string> = {
  bug: TYPE_CONFIG.bug.color,
  feature: TYPE_CONFIG.feature.color,
  task: TYPE_CONFIG.task.color,
  epic: TYPE_CONFIG.epic.color,
  chore: TYPE_CONFIG.chore.color,
  decision: "var(--text-muted)",
  molecule: "var(--text-muted)",
};

const TYPE_LABEL: Record<GraphNodeType, string> = {
  bug: TYPE_CONFIG.bug.label.toLowerCase(),
  feature: TYPE_CONFIG.feature.label.toLowerCase(),
  task: TYPE_CONFIG.task.label.toLowerCase(),
  epic: TYPE_CONFIG.epic.label.toLowerCase(),
  chore: TYPE_CONFIG.chore.label.toLowerCase(),
  decision: "decision",
  molecule: "mol",
};

const STATUS_TEXT: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  closed: "closed",
  deferred: "deferred",
};

export function BeadNode({ data }: NodeProps) {
  const { node, specialist } = data as BeadNodeData;
  const isRunning = specialist?.status === "running";
  const typeColor = TYPE_COLOR[node.type] ?? "var(--text-muted)";
  const typeLabel = TYPE_LABEL[node.type] ?? node.type;
  const statusLabel = node.superseded_by ? "superseded" : STATUS_TEXT[node.status] ?? node.status;
  const agentCat: AgentCategory = categoryFor(specialist?.role);
  const classes = ["g-node", isRunning ? "act" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-p={node.priority}>
      <Handle id="lt" type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="ls" type="source" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="tt" type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle id="ts" type="source" position={Position.Top} style={HANDLE_STYLE} />
      <Handle id="bt" type="target" position={Position.Bottom} style={HANDLE_STYLE} />
      <Handle id="bs" type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <div className="g-node-identity">
        <span className="g-id">{node.id}</span>
        <span className="g-sep">/</span>
        <span className="g-tt">{node.title}</span>
      </div>
      <div className="g-node-class">
        <span className="g-pri" style={{ color: typeColor }}>P{node.priority}</span>
        <span className="g-type" style={{ color: typeColor }}>{typeLabel}</span>
        <span className="g-state">{statusLabel}</span>
        {specialist ? (
          <>
            <span className="g-sep">·</span>
            <span className={`g-ag ${agentCat}`}>
              <span className="g-ag-dot" />
              <b>{specialist.role}</b>/{shortJobId(specialist.job_id)}
            </span>
          </>
        ) : null}
      </div>
      <Handle id="rt" type="target" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="rs" type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  );
}
