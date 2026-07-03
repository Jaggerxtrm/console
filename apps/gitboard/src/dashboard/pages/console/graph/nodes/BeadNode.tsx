// BeadNode — visual register matches IssueFeed rows (forge-2a8a follow-up):
// identity row (id / title) on top, classification row (Pn · type · state · agent)
// on bottom. No priority left rail — Feed has none. Type-coloured Pn + type
// label using the same palette as TYPE_CONFIG in IssueFeed.tsx.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { GraphNode, GraphNodeType, GraphSpecialist } from "../../../../../types/graph.ts";
import type { BeadIssue } from "../../../../../types/beads.ts";
import { TYPE_CONFIG } from "../../../../lib/type-palette.ts";
import { logClientEvent } from "../../../../lib/client-log.ts";
import { beadSideDrawer, useBeadSideDrawer } from "../../../../hooks/useBeadSideDrawer.ts";
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
  const handleOpen = () => {
    const issue = graphNodeToIssue(node);
    const drawer = useBeadSideDrawer.getState();
    drawer.setContext(drawer.projectId, new Map(drawer.issueById).set(node.id, issue));
    logClientEvent("chip.click", { source: "graph_flow_node", beadId: node.id, jobId: specialist?.job_id ?? null });
    beadSideDrawer.open(node.id);
    logClientEvent("chip.inspector.dispatched", { source: "graph_flow_node", beadId: node.id, jobId: specialist?.job_id ?? null });
  };
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    handleOpen();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      handleOpen();
    }
  };
  return (
    <div className={classes} data-p={node.priority} onClick={handleClick} onKeyDown={handleKeyDown} role="button" tabIndex={0} aria-label={`Open ${node.id} issue inspector`}>
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

function graphNodeToIssue(node: GraphNode): BeadIssue {
  return {
    id: node.id,
    title: node.title,
    description: null,
    status: node.status,
    priority: node.priority,
    issue_type: node.type,
    owner: null,
    created_at: "",
    created_by: null,
    updated_at: "",
    project_id: "",
    dependencies: [],
    related_ids: [],
    labels: [],
  };
}
