/**
 * KanbanBoard - secondary overview layout for bead issues
 */

import type { BeadIssue } from "../../../types/beads.ts";
import { StatusColumn } from "./StatusColumn";

interface KanbanBoardProps {
  issues: BeadIssue[];
  onIssueClick?: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
}

const COLUMNS: Array<{ status: BeadIssue["status"]; title: string; description: string }> = [
  { status: "in_progress", title: "In progress", description: "Active operator work" },
  { status: "open", title: "Ready", description: "Unblocked queue" },
  { status: "blocked", title: "Blocked", description: "Needs dependency cleared" },
  { status: "closed", title: "Closed", description: "Recently completed" },
];

export function KanbanBoard({ issues, onIssueClick, getAgent }: KanbanBoardProps) {
  const issuesByStatus = COLUMNS.reduce((acc, col) => {
    acc[col.status] = issues
      .filter((issue) => issue.status === col.status)
      .sort((a, b) => {
        const priorityDiff = (a.priority ?? 99) - (b.priority ?? 99);
        if (priorityDiff !== 0) return priorityDiff;
        return b.updated_at.localeCompare(a.updated_at);
      });
    return acc;
  }, {} as Record<BeadIssue["status"], BeadIssue[]>);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-primary)" }}>
      <div style={{ padding: "14px 18px 10px", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-secondary)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-primary)", margin: 0 }}>Board overview</h2>
            <p style={{ margin: "4px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>Secondary state map. Feed remains the primary dossier surface.</p>
          </div>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", padding: "3px 8px", background: "var(--surface-tertiary)" }}>{issues.length} issues</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, minHeight: 0, flex: 1, overflowX: "auto", padding: 14 }}>
        {COLUMNS.map((col) => (
          <StatusColumn
            key={col.status}
            title={col.title}
            description={col.description}
            status={col.status}
            issues={issuesByStatus[col.status] ?? []}
            onIssueClick={onIssueClick}
            getAgent={getAgent}
          />
        ))}
      </div>
    </div>
  );
}
