import type { GraphEdgeType, GraphNode } from "../../../../types/graph.ts";
import { TYPE_CONFIG } from "../../../lib/type-palette.ts";
import { RELATIONSHIP_LABEL } from "./chainIssueContext.ts";

interface IssueContextChipProps {
  node: GraphNode;
  relation?: GraphEdgeType | "touched";
}

const STATUS_LABEL: Record<string, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  closed: "closed",
  deferred: "deferred",
};

export function IssueContextChip({ node, relation = "touched" }: IssueContextChipProps) {
  const type = TYPE_CONFIG[node.type as keyof typeof TYPE_CONFIG] ?? { label: node.type, color: "var(--text-muted)" };
  const relationLabel = relation === "touched" ? "chain" : RELATIONSHIP_LABEL[relation] ?? relation;
  const status = node.superseded_by ? "superseded" : STATUS_LABEL[node.status] ?? node.status;
  const relationClass = relation === "touched" ? "chain" : relation.replace(/[^a-z0-9]+/g, "-");
  return (
    <span className={`spec-issue-chip g-node spec-issue-chip-${relationClass}`} data-p={node.priority} title={`${node.id} - ${node.title}`}>
      <span className="g-node-identity">
        <span className="g-id">{node.id}</span>
        <span className="g-sep">/</span>
        <span className="g-tt">{node.title}</span>
      </span>
      <span className="g-node-class">
        <span className="g-pri" style={{ color: type.color }}>P{node.priority}</span>
        <span className="g-type" style={{ color: type.color }}>{type.label.toLowerCase()}</span>
        <span className="g-state">{status}</span>
        <span className={`spec-issue-rel spec-issue-rel-${relationClass}`}>{relationLabel}</span>
      </span>
    </span>
  );
}
