import type { ReactNode } from "react";
import { IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, ToolsIcon } from "@primer/octicons-react";
import type { BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  open: "Ready",
  in_review: "In review",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
};

const TYPE_CONFIG: Record<string, { label: string; icon: typeof IssueOpenedIcon; color: string }> = {
  bug: { label: "Bug", icon: IssueOpenedIcon, color: "#ff4d5e" },
  feature: { label: "Feature", icon: NorthStarIcon, color: "#4169e1" },
  task: { label: "Task", icon: ProjectIcon, color: "var(--text-muted)" },
  epic: { label: "Epic", icon: MilestoneIcon, color: "rgba(163,113,247,0.95)" },
  chore: { label: "Chore", icon: ToolsIcon, color: "var(--text-muted)" },
};

export function BeadHeader({ issue, detail, showIdentity = true }: { issue: BeadIssue; detail?: BeadIssueDetail | null; showIdentity?: boolean }) {
  const displayStatus = issue.status === "open" && hasUnresolvedBlocker(issue) ? "blocked" : issue.status;
  const type = TYPE_CONFIG[String(issue.issue_type)] ?? { label: String(issue.issue_type), icon: IssueOpenedIcon, color: "var(--text-muted)" };
  const TypeIcon = type.icon;
  const depsSummary = renderDependenciesSummary(issue);

  return (
    <section className="bead-header">
      {showIdentity && (
        <div className="bead-header-identity">
          <span className="issue-identity"><span className="id">{issue.id}</span><span className="identity-separator">/</span><span className="title">{issue.title}</span></span>
          <span className="issue-classification">
            <span className="priority-mark" style={{ color: type.color }}>P{issue.priority}</span>
            <span className="type-mark" style={{ color: type.color }}>{type.label}</span>
            <span className="state">{(STATUS_LABELS[displayStatus] ?? displayStatus).toLowerCase()}</span>
          </span>
        </div>
      )}
      {depsSummary}
      <div className="bead-dossier-meta-strip">
        <span className="bead-meta-chip bead-meta-type"><b>Type</b><strong><TypeIcon size={12} />{type.label}</strong></span>
        <span className="bead-meta-chip"><b>Priority</b><strong>P{issue.priority}</strong></span>
        <span className={`bead-meta-chip bead-meta-status bead-status-${displayStatus}`}><b>Status</b><strong>{STATUS_LABELS[displayStatus] ?? displayStatus}</strong></span>
        {issue.owner && <span className="bead-meta-chip"><b>Owner</b><strong>{issue.owner}</strong></span>}
        <span className="bead-meta-chip bead-meta-date"><b>Created</b><strong>{formatCompactDate(issue.created_at)}</strong></span>
        <span className="bead-meta-chip bead-meta-date"><b>Updated</b><strong>{formatCompactDate(issue.updated_at)}</strong></span>
        {issue.closed_at && <span className="bead-meta-chip bead-meta-date"><b>Closed</b><strong>{formatCompactDate(issue.closed_at)}</strong></span>}
      </div>
    </section>
  );
}

function renderDependenciesSummary(issue: BeadIssue): ReactNode {
  const count = issue.dependencies.filter((dependency) => dependency.dependency_type !== "parent-child").length;
  if (count === 0) return null;
  return <div className="bead-header-deps">{count} dependenc{count === 1 ? "y" : "ies"}</div>;
}

function hasUnresolvedBlocker(issue: BeadIssue): boolean {
  return issue.dependencies.some((dependency) =>
    (dependency.dependency_type === "blocked_by" || dependency.dependency_type === "blocks") && dependency.status !== "closed",
  );
}

function formatCompactDate(iso: string | undefined): string { if (!iso) return "—"; const date = new Date(iso); if (Number.isNaN(date.getTime())) return iso; return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
