/**
 * BeadCard - compact secondary-board issue card
 */

import { BlockedIcon, DependabotIcon, GitBranchIcon, IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, TagIcon, ToolsIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { BeadIssue } from "../../../types/beads.ts";

interface BeadCardProps {
  issue: BeadIssue;
  onClick?: () => void;
  agent?: string | null;
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

export function BeadCard({ issue, onClick, agent }: BeadCardProps) {
  const blockedBy = issue.dependencies.filter((d) => d.dependency_type === "blocked_by");
  const blocking = issue.dependencies.filter((d) => d.dependency_type === "blocks");
  const type = TYPE_CONFIG[String(issue.issue_type)] ?? { label: String(issue.issue_type), icon: IssueOpenedIcon, color: "var(--text-muted)" };
  const TypeIcon = type.icon;
  const priorityColor = PRIORITY_COLORS[String(issue.priority)] ?? "var(--text-muted)";
  const isEpic = issue.issue_type === "epic";

  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <span style={{ display: "inline-flex", color: type.color, lineHeight: 0 }}><TypeIcon size={13} /></span>
        <span style={{ fontSize: "var(--text-xs)", fontWeight: 750, color: type.color, letterSpacing: "0.05em", textTransform: "uppercase" }}>{type.label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 750, color: priorityColor, border: `1px solid ${priorityColor}`, borderRadius: 999, padding: "1px 6px", lineHeight: 1.4 }}>P{issue.priority}</span>
        {agent && <AgentBadge agent={agent} />}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-muted)", marginLeft: "auto" }}>{issue.id}</span>
      </div>

      <h4 style={{ fontSize: "var(--text-sm)", fontWeight: isEpic ? 700 : 560, color: "var(--text-primary)", lineHeight: 1.35, margin: 0, overflow: "hidden" }}>{issue.title}</h4>

      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, marginTop: 10, minHeight: 18, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
        {blockedBy.length > 0 && <MetaPill title={`${blockedBy.length} blocker(s)`} tone="var(--status-blocked)" icon={<BlockedIcon size={12} />} label={String(blockedBy.length)} />}
        {blocking.length > 0 && <MetaPill title={`Blocks ${blocking.length} issue(s)`} tone="var(--accent-orange)" icon={<GitBranchIcon size={12} />} label={String(blocking.length)} />}
        {issue.labels.length > 0 && <MetaPill title={`${issue.labels.length} label(s)`} tone="var(--text-muted)" icon={<TagIcon size={12} />} label={String(issue.labels.length)} />}
        {issue.related_ids.length > 0 && <span title={`${issue.related_ids.length} related issue(s)`} style={{ marginLeft: "auto", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>rel {issue.related_ids.length}</span>}
      </div>
    </>
  );

  const style = {
    width: "100%",
    background: isEpic ? "linear-gradient(135deg, rgba(163,113,247,0.13), rgba(255,255,255,0.03))" : "var(--surface-secondary)",
    borderRadius: 9,
    padding: "10px 11px",
    border: `1px solid ${isEpic ? "rgba(163,113,247,0.45)" : "var(--border-subtle)"}`,
    borderLeft: `3px solid ${isEpic ? "var(--accent-purple)" : priorityColor}`,
    boxShadow: isEpic ? "inset 0 0 0 1px rgba(163,113,247,0.08)" : "none",
    color: "var(--text-primary)",
    textAlign: "left" as const,
    cursor: onClick ? "pointer" : "default",
    transition: "background 120ms ease, border-color 120ms ease, transform 120ms ease",
  };

  if (!onClick) return <article style={style}>{content}</article>;

  return (
    <button type="button" onClick={onClick} style={{ ...style, appearance: "none", font: "inherit" }}>
      {content}
    </button>
  );
}

function MetaPill({ title, tone, icon, label }: { title: string; tone: string; icon: ReactNode; label: string }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 3, color: tone, background: "rgba(255,255,255,0.035)", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "2px 6px" }}>
      {icon}
      {label}
    </span>
  );
}

function AgentBadge({ agent }: { agent: string }) {
  const colors: Record<string, string> = {
    claude: "#D97706",
    qwen: "#10B981",
    gemini: "#3B82F6",
    gpt: "#6366F1",
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 750, padding: "2px 6px", background: colors[agent] || "var(--surface-tertiary)", color: "white", borderRadius: 999, letterSpacing: "0.03em", textTransform: "uppercase" }}>
      <DependabotIcon size={11} />
      {agent}
    </span>
  );
}
