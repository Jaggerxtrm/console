/**
 * StatusColumn - Kanban column for issues of a specific status
 */

import { AlertIcon, CheckCircleIcon, CircleIcon, DotFillIcon, PlayIcon } from "@primer/octicons-react";
import type { BeadIssue } from "../../../types/beads.ts";
import { BeadCard } from "./BeadCard";

interface StatusColumnProps {
  title: string;
  description?: string;
  status: BeadIssue["status"];
  issues: BeadIssue[];
  onIssueClick?: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
  color?: string;
}

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CircleIcon }> = {
  open: { color: "var(--status-open)", icon: CircleIcon },
  in_progress: { color: "var(--accent-blue)", icon: PlayIcon },
  blocked: { color: "var(--status-blocked)", icon: AlertIcon },
  in_review: { color: "var(--accent-purple)", icon: DotFillIcon },
  closed: { color: "var(--status-closed)", icon: CheckCircleIcon },
};

export function StatusColumn({ title, description, status, issues, onIssueClick, getAgent }: StatusColumnProps) {
  const config = STATUS_CONFIG[String(status)] ?? { color: "var(--text-muted)", icon: CircleIcon };
  const StatusIcon = config.icon;
  const epicCount = issues.filter((issue) => issue.issue_type === "epic").length;

  return (
    <section style={{ display: "flex", flexDirection: "column", minWidth: 286, maxWidth: 326, background: "rgba(255,255,255,0.025)", borderRadius: 10, border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)", background: "rgba(255,255,255,0.025)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: config.color, display: "inline-flex", lineHeight: 0 }}>
            <StatusIcon size={14} />
          </span>
          <h3 style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "0.02em" }}>{title}</h3>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--text-primary)", background: "var(--surface-tertiary)", border: "1px solid var(--border-subtle)", padding: "2px 7px", borderRadius: 999 }}>{issues.length}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          <span>{description ?? "Issue lane"}</span>
          {epicCount > 0 && <span style={{ marginLeft: "auto", color: "var(--accent-purple)", fontWeight: 700 }}>Epic {epicCount}</span>}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 10, display: "flex", flexDirection: "column", gap: 9 }}>
        {issues.length === 0 ? (
          <div style={{ padding: "24px 10px", textAlign: "center", color: "var(--text-muted)", fontSize: "var(--text-sm)", border: "1px dashed var(--border-subtle)", borderRadius: 8, background: "rgba(255,255,255,0.015)" }}>No issues in lane</div>
        ) : (
          issues.map((issue) => (
            <BeadCard
              key={issue.id}
              issue={issue}
              onClick={() => onIssueClick?.(issue)}
              agent={getAgent?.(issue.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}
