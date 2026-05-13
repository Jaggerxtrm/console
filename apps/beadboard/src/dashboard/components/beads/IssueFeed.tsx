/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, LinkIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail } from "../../../types/beads.ts";

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
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const childrenByEpic = useMemo(() => groupChildrenByEpic(issues), [issues]);
  const sortedTopLevelIssues = useMemo(() => {
    return sortIssues(issues).filter((issue) => !isEpicChild(issue, issueById));
  }, [issueById, issues]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sortedTopLevelIssues.length === 0 ? (
          <EmptyFeed />
        ) : (
          sortedTopLevelIssues.map((issue) => {
            const epicChildren = childrenByEpic.get(issue.id) ?? [];
            return (
              <div key={issue.id} style={{ display: "grid", gap: epicChildren.length ? 4 : 0 }}>
                <IssueRow
                  issue={issue}
                  detail={selectedIssueId === issue.id ? selectedIssueDetail : null}
                  isExpanded={selectedIssueId === issue.id}
                  isLoadingDetail={loadingDetailId === issue.id}
                  agent={getAgent?.(issue.id) ?? null}
                  childIssues={epicChildren}
                  issueById={issueById}
                  onClick={() => onIssueSelect(issue)}
                />
                {epicChildren.length > 0 && (
                  <div style={{ marginLeft: 22, paddingLeft: 14, borderLeft: "1px solid rgba(163,113,247,0.45)", display: "grid", gap: 4 }}>
                    {sortIssues(epicChildren).map((child) => (
                      <IssueRow
                        key={child.id}
                        issue={child}
                        detail={selectedIssueId === child.id ? selectedIssueDetail : null}
                        isExpanded={selectedIssueId === child.id}
                        isLoadingDetail={loadingDetailId === child.id}
                        agent={getAgent?.(child.id) ?? null}
                        childIssues={[]}
                        issueById={issueById}
                        depth={1}
                        onClick={() => onIssueSelect(child)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function sortIssues(items: BeadIssue[]): BeadIssue[] {
  return [...items].sort((a, b) => {
    const statusDiff = rankStatus(a.status) - rankStatus(b.status);
    if (statusDiff !== 0) return statusDiff;
    const priorityDiff = (a.priority ?? 99) - (b.priority ?? 99);
    if (priorityDiff !== 0) return priorityDiff;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

function groupChildrenByEpic(issues: BeadIssue[]): Map<string, BeadIssue[]> {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const groups = new Map<string, BeadIssue[]>();
  for (const issue of issues) {
    const epicId = getEpicParentId(issue, issueById);
    if (!epicId) continue;
    const children = groups.get(epicId) ?? [];
    children.push(issue);
    groups.set(epicId, children);
  }
  return groups;
}

function isEpicChild(issue: BeadIssue, issueById: Map<string, BeadIssue>): boolean {
  return Boolean(getEpicParentId(issue, issueById));
}

function getEpicParentId(issue: BeadIssue, issueById: Map<string, BeadIssue>): string | null {
  if (issue.parent_id && issueById.get(issue.parent_id)?.issue_type === "epic") return issue.parent_id;
  const parentDependency = issue.dependencies.find((dependency) => dependency.dependency_type === "parent-child" && issueById.get(dependency.id)?.issue_type === "epic");
  return parentDependency?.id ?? null;
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
  childIssues,
  issueById,
  depth = 0,
  onClick,
}: {
  issue: BeadIssue;
  detail: BeadIssueDetail | null;
  isExpanded: boolean;
  isLoadingDetail: boolean;
  agent: string | null;
  childIssues: BeadIssue[];
  issueById: Map<string, BeadIssue>;
  depth?: number;
  onClick: () => void;
}) {
  const isEpic = issue.issue_type === "epic";
  const visibleDependencies = issue.dependencies.filter((dependency) => dependency.dependency_type !== "parent-child");
  const dependencyCount = visibleDependencies.length;
  const childCount = childIssues.length || detail?.children?.length || 0;
  const rowTone = String(issue.status).replaceAll("-", "_");

  return (
    <article className={`bead-row ${rowTone} ${isEpic ? "epic" : ""} ${isExpanded ? "is-expanded" : ""}`} style={depth > 0 ? { marginLeft: 0 } : undefined}>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={isExpanded}
        aria-controls={`issue-dossier-${issue.id}`}
        className="bead-row-main"
      >
        <span className="bead-chevron"><ChevronDownIcon size={14} /></span>
        <span className="bead-number">{issue.id}</span>
        <div className="bead-title-block">
          <div className="bead-title-line">
            <span className="bead-title">{issue.title}</span>
          </div>
          <div className="bead-meta-line">
            <span>{STATUS_LABELS[issue.status] ?? issue.status}</span>
            <span>{issue.owner ?? "unassigned"}</span>
            <span>updated {formatCompactDate(issue.updated_at)}</span>
          </div>
        </div>
        <TypePill type={issue.issue_type} isEpic={isEpic} />
        <div className="bead-row-stats">
          <span>P{issue.priority}</span>
          {dependencyCount > 0 && <span>{dependencyCount} deps</span>}
          {childCount > 0 && <span>{childCount} children</span>}
          {agent && <span>{agent}</span>}
        </div>
        <span className="bead-chevron"><ChevronRightIcon size={14} /></span>
      </button>

      {isExpanded && (
        <IssueDossier id={`issue-dossier-${issue.id}`} detail={detail} issue={issue} loading={isLoadingDetail} childIssues={childIssues} issueById={issueById} />
      )}
    </article>
  );
}

function IssueDossier({ id, detail, issue, loading, childIssues, issueById }: { id: string; detail: BeadIssueDetail | null; issue: BeadIssue; loading: boolean; childIssues: BeadIssue[]; issueById: Map<string, BeadIssue> }) {
  if (loading) {
    return <div id={id} className="bead-expanded-body"><div className="bead-empty-note">Loading dossier...</div></div>;
  }

  const dependencies = enrichDependencies((detail?.dependencies ?? issue.dependencies).filter((dependency) => dependency.dependency_type !== "parent-child"), issueById);
  const parentLinks = enrichDependencies((detail?.dependencies ?? issue.dependencies).filter((dependency) => dependency.dependency_type === "parent-child"), issueById);
  const dependents = enrichDependencies((detail?.dependents ?? []).filter((dependency) => dependency.dependency_type !== "parent-child"), issueById);
  const children = detail?.children?.length ? detail.children : childIssues.map((child) => ({ id: child.id, title: child.title, status: child.status, dependency_type: "parent-child" }));

  return (
    <section id={id} className="bead-expanded-body">
      <div className="bead-expanded-grid">
        <div style={{ display: "grid", gap: 10 }}>
          <DossierSection title="Description">
            <Markdown value={detail?.description ?? issue.description} empty="No description." />
          </DossierSection>
          <DossierSection title="Notes">
            <Markdown value={detail?.notes ?? issue.notes} empty="No notes." />
          </DossierSection>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <DossierList title="Depends on" items={dependencies} empty="No blockers." />
          <DossierList title="Blocks" items={dependents} empty="No downstream issues." />
          <DossierList title="Epic / parent" items={parentLinks} empty="No parent link." />
          <DossierList title="Children" items={children} empty="No child issues." />
          <DossierSection title="Metadata">
            <div className="bead-dossier-list">
              <span><b>Created</b><strong>{formatCompactDate(issue.created_at)}</strong></span>
              <span><b>Updated</b><strong>{formatCompactDate(issue.updated_at)}</strong></span>
              {issue.closed_at && <span><b>Closed</b><strong>{formatCompactDate(issue.closed_at)}</strong></span>}
            </div>
          </DossierSection>
        </div>
      </div>
      {!detail && <div className="bead-empty-note" style={{ marginTop: 8 }}>Partial dossier; issue detail API returned no extended payload.</div>}
    </section>
  );
}

function enrichDependencies(items: BeadDependency[], issueById: Map<string, BeadIssue>): BeadDependency[] {
  return items.map((item) => {
    const issue = issueById.get(item.id);
    return issue ? { ...item, title: item.title || issue.title, status: issue.status } : item;
  });
}

function DossierSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 7 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 750 }}>{title}</div>
      {children}
    </section>
  );
}

function DossierList({ title, items, empty }: { title: string; items: Array<{ id: string; title: string; status: string; dependency_type: string }>; empty: string }) {
  return (
    <section style={{ border: "1px solid var(--border-subtle)", borderRadius: 9, background: "rgba(255,255,255,0.025)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: "var(--text-xs)", fontWeight: 750, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <GitBranchIcon size={12} />
        {title}
      </div>
      <div style={{ display: "grid", gap: 0 }}>
        {items.length === 0 ? (
          <div style={{ padding: 9, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{empty}</div>
        ) : items.map((item) => (
          <div key={`${title}-${item.id}-${item.dependency_type}`} style={{ display: "grid", gap: 3, padding: 9, borderTop: "1px solid rgba(255,255,255,0.035)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <LinkIcon size={12} />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{item.id}</span>
              <StatusPill status={item.status} />
            </div>
            <div style={{ color: "var(--text-primary)", fontSize: "var(--text-sm)", lineHeight: 1.35 }}>{item.title || "Untitled issue"}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Markdown({ value, empty }: { value?: string | null; empty: string }) {
  if (!value?.trim()) return <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{empty}</div>;
  return <div style={{ display: "grid", gap: 7 }}>{parseMarkdown(value)}</div>;
}

function parseMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  let list: string[] = [];
  let code: string[] | null = null;

  function flushList(key: string) {
    if (!list.length) return;
    nodes.push(<ul key={key} style={{ margin: "0 0 0 18px", color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>{list.map((item, index) => <li key={`${key}-${index}`}>{renderInlineMarkdown(item)}</li>)}</ul>);
    list = [];
  }

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (code) {
        nodes.push(<pre key={`code-${index}`} style={{ margin: 0, padding: 10, borderRadius: 8, background: "var(--surface-primary)", border: "1px solid var(--border-subtle)", overflowX: "auto", color: "var(--text-secondary)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        flushList(`list-before-code-${index}`);
        code = [];
      }
      return;
    }

    if (code) {
      code.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushList(`list-${index}`);
      return;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList(`list-before-heading-${index}`);
      nodes.push(<div key={`heading-${index}`} style={{ color: "var(--text-primary)", fontWeight: 750, fontSize: heading[1].length === 1 ? "var(--text-base)" : "var(--text-sm)", marginTop: 3 }}>{renderInlineMarkdown(heading[2])}</div>);
      return;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }

    flushList(`list-before-p-${index}`);
    if (trimmed.startsWith(">")) {
      nodes.push(<blockquote key={`quote-${index}`} style={{ margin: 0, padding: "6px 9px", borderLeft: "2px solid var(--accent-blue)", color: "var(--text-secondary)", background: "rgba(88,166,255,0.06)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>{renderInlineMarkdown(trimmed.slice(1).trim())}</blockquote>);
      return;
    }

    nodes.push(<p key={`p-${index}`} style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>{renderInlineMarkdown(trimmed)}</p>);
  });

  flushList("list-final");
  const trailingCode = code;
  if (trailingCode) nodes.push(<pre key="code-final" style={{ margin: 0, padding: 10, borderRadius: 8, background: "var(--surface-primary)", border: "1px solid var(--border-subtle)", overflowX: "auto", color: "var(--text-secondary)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}><code>{(trailingCode as string[]).join("\n")}</code></pre>);
  return nodes;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} style={{ background: "var(--surface-tertiary)", borderRadius: 4, padding: "1px 4px", color: "var(--text-primary)", fontSize: "0.95em" }}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} style={{ color: "var(--text-primary)" }}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function formatCompactDate(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StatusPill({ status }: { status: string }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: "var(--surface-tertiary)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{STATUS_LABELS[status] ?? status}</span>;
}

function TypePill({ type, isEpic }: { type: string; isEpic: boolean }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: isEpic ? "var(--accent-purple)" : "var(--surface-tertiary)", color: isEpic ? "white" : "var(--text-secondary)", whiteSpace: "nowrap" }}>{ISSUE_TYPE_LABEL[type] ?? type}</span>;
}

function PriorityPill({ priority }: { priority: number }) {
  return <span style={{ fontSize: "var(--text-xs)", padding: "2px 8px", borderRadius: 999, background: "var(--surface-tertiary)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>P{priority}</span>;
}

function EmptyFeed() {
  return <div style={{ padding: 20, color: "var(--text-muted)", border: "1px dashed var(--border-subtle)", borderRadius: 12 }}>No issues</div>;
}
