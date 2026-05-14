/**
 * BeadCard - compact secondary-board issue card
 */

import { DependabotIcon, IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, ToolsIcon } from "@primer/octicons-react";
import type { BeadIssue } from "../../../types/beads.ts";

interface BeadCardProps {
  issue: BeadIssue;
  onClick?: () => void;
  agent?: string | null;
  isExpanded?: boolean;
}

const TYPE_CONFIG: Record<string, { label: string; icon: typeof IssueOpenedIcon; color: string }> = {
  bug: { label: "Bug", icon: IssueOpenedIcon, color: "var(--status-blocked)" },
  feature: { label: "Feature", icon: NorthStarIcon, color: "var(--accent-blue)" },
  task: { label: "Task", icon: ProjectIcon, color: "var(--text-secondary)" },
  epic: { label: "Epic", icon: MilestoneIcon, color: "var(--accent-purple)" },
  chore: { label: "Chore", icon: ToolsIcon, color: "var(--text-muted)" },
};

const PRIORITY_COLORS: Record<string, string> = {
  "0": "var(--status-blocked)",
  "1": "var(--accent-orange)",
  "2": "var(--accent-blue)",
  "3": "var(--text-muted)",
  "4": "var(--text-disabled)",
};

export function BeadCard({ issue, onClick, agent, isExpanded = false }: BeadCardProps) {
  const type = TYPE_CONFIG[String(issue.issue_type)] ?? { label: String(issue.issue_type), icon: IssueOpenedIcon, color: "var(--text-muted)" };
  const TypeIcon = type.icon;
  const priorityColor = PRIORITY_COLORS[String(issue.priority)] ?? "var(--text-muted)";
  const isEpic = issue.issue_type === "epic";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isExpanded}
      style={{
        width: "100%",
        background: isExpanded ? "var(--surface-primary)" : "var(--surface-secondary)",
        borderRadius: "var(--radius-sm)",
        padding: "8px 9px",
        border: "1px solid var(--border-subtle)",
        borderLeft: `3px solid ${isEpic ? "var(--accent-purple)" : priorityColor}`,
        boxShadow: "none",
        color: "var(--text-primary)",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        transition: "background 120ms ease, border-color 120ms ease",
        appearance: "none",
        font: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ display: "inline-flex", color: type.color, lineHeight: 0 }}><TypeIcon size={13} /></span>
        <span style={{ fontSize: "var(--text-xs)", fontWeight: 750, color: type.color, letterSpacing: "0.05em", textTransform: "uppercase" }}>{type.label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-muted)", marginLeft: "auto" }}>{issue.id}</span>
      </div>

      <h4 style={{ fontSize: "var(--text-sm)", fontWeight: isEpic ? 700 : 560, color: "var(--text-primary)", lineHeight: 1.3, margin: "5px 0 0", overflow: "hidden" }}>{issue.title}</h4>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
        <span>P{issue.priority}</span>
        {agent && <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><DependabotIcon size={11} />{agent}</span>}
        {issue.dependencies.length > 0 && <span>{issue.dependencies.length} deps</span>}
        {issue.labels.length > 0 && <span>{issue.labels.length} labels</span>}
      </div>
    </button>
  );
}
