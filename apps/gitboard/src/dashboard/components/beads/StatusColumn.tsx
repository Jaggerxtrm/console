/**
 * StatusColumn - Kanban column for issues of a specific status
 */

import { AlertIcon, CheckCircleIcon, CircleIcon, DotFillIcon, PlayIcon } from "@primer/octicons-react";
import type { BeadIssue } from "../../../types/beads.ts";
import type { OpenPr } from "../../lib/beads-api.ts";
import { BeadCard } from "./BeadCard";

interface StatusColumnProps {
  title: string;
  description?: string;
  status: BeadIssue["status"];
  issues: BeadIssue[];
  selectedId: string | null;
  onSelect: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
  prByIssueId?: Map<string, OpenPr>;
}

const STATUS_CONFIG: Record<string, { color: string; icon: typeof CircleIcon }> = {
  open: { color: "var(--status-open)", icon: CircleIcon },
  in_progress: { color: "var(--accent-blue)", icon: PlayIcon },
  blocked: { color: "var(--status-blocked)", icon: AlertIcon },
  in_review: { color: "var(--accent-purple)", icon: DotFillIcon },
  closed: { color: "var(--status-closed)", icon: CheckCircleIcon },
};

export function StatusColumn({ title, description, status, issues, selectedId, onSelect, getAgent, prByIssueId }: StatusColumnProps) {
  const config = STATUS_CONFIG[String(status)] ?? { color: "var(--text-muted)", icon: CircleIcon };
  const StatusIcon = config.icon;
  const epicCount = issues.filter((issue) => issue.issue_type === "epic").length;

  return (
    <section style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minWidth: 260, background: "var(--surface-secondary)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
      <div style={{ padding: "7px 9px", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-secondary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: config.color, display: "inline-flex", lineHeight: 0 }}><StatusIcon size={13} /></span>
          <h3 style={{ fontSize: "var(--text-xs)", fontWeight: 750, color: "var(--text-primary)", margin: 0, letterSpacing: "0.04em", textTransform: "uppercase" }}>{title}</h3>
          <span style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--text-primary)", background: "var(--surface-tertiary)", border: "1px solid var(--border-subtle)", padding: "1px 6px", borderRadius: "var(--radius-sm)" }}>{issues.length}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          <span>{description ?? "Issue lane"}</span>
          {epicCount > 0 && <span style={{ marginLeft: "auto", color: "var(--accent-purple)", fontWeight: 700 }}>Epic {epicCount}</span>}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: 6, display: "flex", flexDirection: "column", gap: 5 }}>
        {issues.length === 0 ? (
          <div style={{ padding: "20px 10px", textAlign: "center", color: "var(--text-muted)", fontSize: "var(--text-xs)", border: "1px dashed var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--surface-primary)" }}>No issues in lane</div>
        ) : (
          issues.map((issue) => (
            <BeadCard
              key={issue.id}
              issue={issue}
              onClick={() => onSelect(issue)}
              agent={getAgent?.(issue.id)}
              isExpanded={selectedId === issue.id}
              prLink={prByIssueId?.get(issue.id) ?? null}
            />
          ))
        )}
      </div>
    </section>
  );
}
