/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useMemo } from "react";
import type { BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";

interface IssueFeedProps {
  issues: BeadIssue[];
  selectedIssueId: string | null;
  selectedIssueDetail: BeadIssueDetail | null;
  loadingDetailId: string | null;
  onIssueSelect: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
}

const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  open: 1,
  in_review: 2,
  blocked: 3,
  deferred: 4,
  closed: 5,
};

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  open: "Ready",
  in_review: "In review",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
};

const ISSUE_TYPE_LABEL: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
  chore: "Chore",
};

export function IssueFeed({
  issues,
  selectedIssueId,
  selectedIssueDetail,
  loadingDetailId,
  onIssueSelect,
  getAgent,
}: IssueFeedProps) {
  const sortedIssues = useMemo(() => {
    return [...issues].sort((a, b) => {
      const statusDiff = rankStatus(a.status) - rankStatus(b.status);
      if (statusDiff !== 0) return statusDiff;
      const priorityDiff = (a.priority ?? 99) - (b.priority ?? 99);
      if (priorityDiff !== 0) return priorityDiff;
      return b.updated_at.localeCompare(a.updated_at);
    });
  }, [issues]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sortedIssues.length === 0 ? (
          <EmptyFeed />
        ) : (
          sortedIssues.map((issue) => {
            const isExpanded = selectedIssueId === issue.id;
            const detail = isExpanded ? selectedIssueDetail : null;
            return (
              <IssueRow
                key={issue.id}
                issue={issue}
                detail={detail}
                isExpanded={isExpanded}
                isLoadingDetail={loadingDetailId === issue.id}
                agent={getAgent?.(issue.id) ?? null}
                onClick={() => onIssueSelect(issue)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function rankStatus(status: string): number {
  return STATUS_RANK[status] ?? 99;
}

function IssueRow({
  issue,
  detail,
  isExpanded,
  isLoadingDetail,
  agent,
  onClick,
}: {
  issue: BeadIssue;
  detail: BeadIssueDetail | null;
  isExpanded: boolean;
  isLoadingDetail: boolean;
  agent: string | null;
  onClick: () => void;
}) {
  const isEpic = issue.issue_type === "epic";
  const dependencyCount = (detail?.dependencies ?? issue.dependencies).length;
  const dependentCount = detail?.dependents.length ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isExpanded}
      aria-controls={`issue-dossier-${issue.id}`}
      style={{
        textAlign: "left",
        width: "100%",
        border: isEpic ? "1px solid var(--accent-blue)" : "1px solid var(--border-subtle)",
        borderRadius: isEpic ? 14 : 10,
        background: isEpic ? "rgba(59, 130, 246, 0.08)" : "var(--surface-secondary)",
        padding: 12,
        cursor: "pointer",
        color: "inherit",
        outline: "none",
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      onFocus={(event) => {
        event.currentTarget.style.boxShadow = "0 0 0 2px var(--accent-blue)";
      }}
      onBlur={(event) => {
        event.currentTarget.style.boxShadow = "none";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <StatusPill status={issue.status} />
        <TypePill type={issue.issue_type} isEpic={isEpic} />
        <PriorityPill priority={issue.priority} />
        <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{issue.id}</span>
        {agent && <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{agent}</span>}
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "var(--text-base)", color: "var(--text-primary)", fontWeight: 600 }}>
          {issue.title}
        </h3>
        {issue.owner && <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{issue.owner}</span>}
      </div>

      {issue.description && (
        <p style={{ margin: "6px 0 0", color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
          {issue.description}
        </p>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 8, color: "var(--text-muted)", fontSize: "var(--text-xs)", flexWrap: "wrap" }}>
        <span>{STATUS_LABELS[issue.status] ?? issue.status}</span>
        {dependencyCount > 0 && <span>{dependencyCount} deps</span>}
        {dependentCount > 0 && <span>{dependentCount} children</span>}
        {issue.labels.length > 0 && <span>{issue.labels.length} labels</span>}
      </div>

      {isExpanded && (
        <IssueDossier id={`issue-dossier-${issue.id}`} detail={detail} issue={issue} loading={isLoadingDetail} />
      )}
    </button>
  );
}

function IssueDossier({ id, detail, issue, loading }: { id: string; detail: BeadIssueDetail | null; issue: BeadIssue; loading: boolean }) {
  if (loading) {
    return <div id={id} style={{ marginTop: 12, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>Loading dossier...</div>;
  }

  const dependencyItems = detail?.dependencies ?? issue.dependencies;
  const dependentItems = detail?.dependents ?? [];

  return (
    <section id={id} style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-subtle)", display: "grid", gap: 12 }}>
      <DossierBlock title="Context" lines={[
        issue.closed_at ? `Closed ${issue.closed_at}` : `Updated ${issue.updated_at}`,
        issue.parent_id ? `Parent ${issue.parent_id}` : null,
      ]} />
      <DossierBlock title="Depends on" items={dependencyItems} />
      <DossierBlock title="Children / dependents" items={dependentItems} />
      {!detail && <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>Partial dossier; more data from issue detail API.</div>}
    </section>
  );
}

function DossierBlock({ title, lines, items }: { title: string; lines?: Array<string | null>; items?: Array<{ id: string; title: string; status: string; dependency_type: string }> }) {
  const textLines = (lines ?? []).filter((line): line is string => Boolean(line));
  return (
    <div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{title}</div>
      {textLines.length > 0 && <div style={{ display: "grid", gap: 4 }}>{textLines.map((line) => <div key={line} style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>{line}</div>)}</div>}
      {items && items.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          {items.map((item) => (
            <div key={`${item.id}-${item.dependency_type}`} style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
              {item.id} · {item.title} · {item.status}
            </div>
          ))}
        </div>
      )}
      {!textLines.length && (!items || items.length === 0) && <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>None</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: "var(--surface-tertiary)", color: "var(--text-secondary)" }}>{STATUS_LABELS[status] ?? status}</span>;
}

function TypePill({ type, isEpic }: { type: string; isEpic: boolean }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: isEpic ? "var(--accent-blue)" : "var(--surface-tertiary)", color: isEpic ? "white" : "var(--text-secondary)" }}>{ISSUE_TYPE_LABEL[type] ?? type}</span>;
}

function PriorityPill({ priority }: { priority: number }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: "var(--surface-tertiary)", color: "var(--text-secondary)" }}>P{priority}</span>;
}

function EmptyFeed() {
  return <div style={{ padding: 20, color: "var(--text-muted)", border: "1px dashed var(--border-subtle)", borderRadius: 12 }}>No issues</div>;
}
