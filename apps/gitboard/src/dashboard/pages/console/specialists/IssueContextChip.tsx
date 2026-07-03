import type { GraphEdgeType, GraphNode } from "../../../../types/graph.ts";
import type { BeadIssue } from "../../../../types/beads.ts";
import { beadSideDrawer, useBeadSideDrawer } from "../../../hooks/useBeadSideDrawer.ts";
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
  const openIssue = () => {
    const issue = graphNodeToIssue(node);
    const drawer = useBeadSideDrawer.getState();
    drawer.setContext(drawer.projectId, new Map(drawer.issueById).set(node.id, issue));
    beadSideDrawer.open(node.id);
  };
  return (
    <button type="button" className={`spec-issue-chip g-node spec-issue-chip-${relationClass}`} data-p={node.priority} title={`${node.id} - ${node.title}`} onClick={openIssue}>
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
    </button>
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
