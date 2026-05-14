/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon, ChevronDownIcon, GitBranchIcon, LinkIcon, AlertIcon, IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, ToolsIcon, DependabotIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail, Interaction } from "../../../types/beads.ts";
import { api } from "../../lib/api.ts";

interface IssueFeedProps {
  issues: BeadIssue[];
  selectedIssueId: string | null;
  selectedIssueDetail: BeadIssueDetail | null;
  loadingDetailId: string | null;
  onIssueSelect: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
  projectId: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In progress",
  open: "Ready",
  in_review: "In review",
  blocked: "Blocked",
  deferred: "Deferred",
  closed: "Closed",
};

const TYPE_LABELS: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
  chore: "Chore",
};

const TYPE_ICONS: Record<string, typeof IssueOpenedIcon> = {
  bug: IssueOpenedIcon,
  feature: NorthStarIcon,
  task: ProjectIcon,
  epic: MilestoneIcon,
  chore: ToolsIcon,
};

export function IssueFeed({ issues, selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, getAgent, projectId }: IssueFeedProps) {
  const issueById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);
  const epicChildren = useMemo(() => groupChildrenByEpic(issues), [issues]);
  const topLevelIssues = useMemo(() => issues.filter((issue) => !getEpicParentId(issue, issueById)), [issueById, issues]);

  return (
    <div className="bead-feed">
      <div className="module-list">
        {topLevelIssues.length === 0 ? (
          <EmptyFeed />
        ) : (
          topLevelIssues.map((issue) => {
            const children = epicChildren.get(issue.id) ?? [];
            return (
              <div key={issue.id}>
                <IssueRow
                  issue={issue}
                  detail={selectedIssueId === issue.id ? selectedIssueDetail : null}
                  isExpanded={selectedIssueId === issue.id}
                  isLoadingDetail={loadingDetailId === issue.id}
                  agent={getAgent?.(issue.id) ?? null}
                  dependencyCount={countDependencies(issue)}
                  childCount={children.length}
                  onClick={() => onIssueSelect(issue)}
                  projectId={projectId}
                  issueById={issueById}
                />
                {children.length > 0 && <EpicChildren issues={children} selectedIssueId={selectedIssueId} selectedIssueDetail={selectedIssueDetail} loadingDetailId={loadingDetailId} onIssueSelect={onIssueSelect} getAgent={getAgent} projectId={projectId} issueById={issueById} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function EpicChildren({ issues, selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, getAgent, projectId, issueById }: { issues: BeadIssue[]; selectedIssueId: string | null; selectedIssueDetail: BeadIssueDetail | null; loadingDetailId: string | null; onIssueSelect: (issue: BeadIssue) => void; getAgent?: (issueId: string) => string | null; projectId: string | null; issueById: Map<string, BeadIssue>; }) {
  const sorted = [...issues].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return <div className="epic-children">{sorted.map((issue) => <IssueRow key={issue.id} issue={issue} detail={selectedIssueId === issue.id ? selectedIssueDetail : null} isExpanded={selectedIssueId === issue.id} isLoadingDetail={loadingDetailId === issue.id} agent={getAgent?.(issue.id) ?? null} dependencyCount={countDependencies(issue)} childCount={groupChildrenByEpic(issues).get(issue.id)?.length ?? 0} onClick={() => onIssueSelect(issue)} isChild projectId={projectId} issueById={issueById} />)}</div>;
}

function IssueRow({ issue, detail, isExpanded, isLoadingDetail, agent, dependencyCount, childCount, onClick, isChild = false, projectId, issueById }: { issue: BeadIssue; detail: BeadIssueDetail | null; isExpanded: boolean; isLoadingDetail: boolean; agent: string | null; dependencyCount: number; childCount: number; onClick: () => void; isChild?: boolean; projectId: string | null; issueById: Map<string, BeadIssue>; }) {
  const isEpic = issue.issue_type === "epic";
  const TypeIcon = TYPE_ICONS[issue.issue_type] ?? IssueOpenedIcon;

  return (
    <article className={`row ${issue.status} ${isEpic ? "epic" : ""} ${isExpanded ? "is-expanded" : ""} ${isChild ? "is-child" : ""}`}>
      <button type="button" className="row-main" onClick={onClick} aria-expanded={isExpanded} aria-controls={`issue-dossier-${issue.id}`}>
        <span className="id">{issue.id}</span>
        <span className="title-col">
          <span className="title">{issue.title}</span>
          <span className="meta">{issue.owner ?? "unassigned"}<span>{formatCompactDate(issue.updated_at)}</span>{childCount > 0 && <span>{childCount} children</span>}</span>
        </span>
        <span className="type-mark" title={TYPE_LABELS[issue.issue_type] ?? issue.issue_type}><TypeIcon size={13} /></span>
        <span className="meta-right">{renderInlineDeps(issue, dependencyCount)}{agent && <span className="agent-badge"><DependabotIcon size={10} /> {agent}</span>}</span>
        <span className="state">{STATUS_LABELS[issue.status] ?? issue.status}</span>
        <span className="chev">{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
      </button>
      {isExpanded && <IssueDossier id={`issue-dossier-${issue.id}`} detail={detail} issue={issue} loading={isLoadingDetail} projectId={projectId} issueById={issueById} />}
    </article>
  );
}

function IssueDossier({ id, detail, issue, loading, projectId, issueById }: { id: string; detail: BeadIssueDetail | null; issue: BeadIssue; loading: boolean; projectId: string | null; issueById: Map<string, BeadIssue>; }) {
  const [interactions, setInteractions] = useState<Interaction[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadInteractions() {
      if (!projectId) return;
      try {
        const data = await api.getInteractions(projectId, issue.id);
        if (!cancelled) setInteractions(data);
      } catch (error) {
        if (!cancelled) {
          console.error(error);
          setInteractions([]);
        }
      }
    }

    loadInteractions();
    return () => {
      cancelled = true;
    };
  }, [issue.id, projectId]);

  if (loading) return <div id={id} className="bead-expanded-body"><div className="bead-empty-note">Loading dossier...</div></div>;
  const allDeps = detail?.dependencies ?? issue.dependencies;
  const related = (detail?.related_ids ?? issue.related_ids ?? []);
  const children = detail?.children ?? [];
  const labels = detail?.labels ?? issue.labels ?? [];
  const isEpic = issue.issue_type === "epic";
  return (
    <section id={id} className="bead-expanded-body">
      <div className="bead-expanded-grid">
        <div className="bead-dossier-main">
          <DossierSection title="Description"><SafeMarkdown value={detail?.description ?? issue.description} empty="No description." /></DossierSection>
          {(detail?.notes ?? issue.notes) && (
            <DossierSection title="Notes"><SafeMarkdown value={detail?.notes ?? issue.notes} empty="No notes." /></DossierSection>
          )}
        </div>
        <div className="bead-dossier-side">
          {(allDeps.length > 0 || children.length > 0) && (
            <DossierSection title="Dependency tree">
              <DependencyTree issue={issue} dependencies={allDeps} childDeps={children} issueById={issueById} />
            </DossierSection>
          )}
          {related.length > 0 && (
            <DossierSection title="Related">
              <ul className="bead-dep-list">{related.map((rid) => <li key={`rel-${rid}`}><span className="bead-dep-id">{rid}</span></li>)}</ul>
            </DossierSection>
          )}
          {labels.length > 0 && (
            <DossierSection title="Labels"><div className="bead-label-strip">{labels.map((l) => <span key={l} className="bead-label-chip">{l}</span>)}</div></DossierSection>
          )}
          {interactions.length > 0 && (
            <DossierSection title="Audit log">
              <div className="bead-audit-log">
                {interactions.map((interaction) => <div key={interaction.id} className="bead-audit-item"><span className="bead-audit-kind">{interaction.kind}</span><span>{interaction.actor}</span><span>{formatCompactDate(interaction.created_at)}</span>{interaction.model && <span>{interaction.model}</span>}</div>)}
              </div>
            </DossierSection>
          )}
          <DossierSection title="Metadata">
            <div className="bead-dossier-list">
              <span><b>Status</b><strong>{issue.status}</strong></span>
              <span><b>Priority</b><strong>P{issue.priority}</strong></span>
              <span><b>Type</b><strong>{issue.issue_type}</strong></span>
              {issue.owner && <span><b>Owner</b><strong>{issue.owner}</strong></span>}
              <span><b>Created</b><strong>{formatCompactDate(issue.created_at)}</strong></span>
              <span><b>Updated</b><strong>{formatCompactDate(issue.updated_at)}</strong></span>
              {issue.closed_at && <span><b>Closed</b><strong>{formatCompactDate(issue.closed_at)}</strong></span>}
            </div>
          </DossierSection>
        </div>
      </div>
    </section>
  );
}

function DossierSection({ title, children }: { title: string; children: ReactNode }) { return <section className="bead-expanded-section"><div className="bead-section-title">{title}</div>{children}</section>; }

function SafeMarkdown({ value, empty }: { value?: string | null; empty: string }) {
  if (!value?.trim()) return <div className="bead-empty-note">{empty}</div>;
  return <div className="bead-body-text">{renderSafeBody(value)}</div>;
}

// Renders prose with markdown affordances (code fences, inline code, **bold**, *em*, [link], headers, lists, blockquotes).
// HTML/XML-like content is rendered safely:
//   - <script>/<style> blocks are dropped entirely
//   - on*= attributes are stripped
//   - block-level HTML tags (<p>, <li>, <h*>, <br>) are normalised to markdown
//   - remaining tags are left as escaped text so XML structure stays visible
function renderSafeBody(raw: string): ReactNode[] {
  const sanitised = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
  const lines = sanitised
    .replace(/<\/?details[^>]*>/gi, "\n")
    .replace(/<summary[^>]*>/gi, "\n### ")
    .replace(/<\/summary>/gi, "\n")
    .replace(/<h[1-4][^>]*>/gi, "\n### ")
    .replace(/<\/h[1-4]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<blockquote[^>]*>/gi, "> ")
    .replace(/\r\n/g, "\n")
    .split("\n");

  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: ReactNode[] = [];
  let fenceLang: string | null = null;
  let fenceBuf: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    nodes.push(<p key={`p-${nodes.length}`}>{paragraph.flatMap((line, idx) => [renderInline(line, `p${nodes.length}-${idx}`), idx < paragraph.length - 1 ? <br key={`br-${nodes.length}-${idx}`} /> : null])}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(<ul key={`ul-${nodes.length}`}>{listItems}</ul>);
    listItems = [];
  };

  lines.forEach((rawLine) => {
    const fenceMatch = rawLine.match(/^\s*```(\w*)/);
    if (fenceLang !== null) {
      if (fenceMatch) {
        nodes.push(<pre key={`pre-${nodes.length}`} data-lang={fenceLang || undefined}><code>{fenceBuf.join("\n")}</code></pre>);
        fenceLang = null;
        fenceBuf = [];
        return;
      }
      fenceBuf.push(rawLine);
      return;
    }
    if (fenceMatch) {
      flushParagraph();
      flushList();
      fenceLang = fenceMatch[1] ?? "";
      return;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6");
      nodes.push(<Tag key={`h-${nodes.length}`}>{renderInline(heading[2], `h${nodes.length}`)}</Tag>);
      return;
    }
    const li = trimmed.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushParagraph();
      listItems.push(<li key={`li-${listItems.length}`}>{renderInline(li[1], `li${nodes.length}-${listItems.length}`)}</li>);
      return;
    }
    const bq = trimmed.match(/^>\s?(.*)$/);
    if (bq) {
      flushParagraph();
      flushList();
      nodes.push(<blockquote key={`bq-${nodes.length}`}>{renderInline(bq[1], `bq${nodes.length}`)}</blockquote>);
      return;
    }
    flushList();
    paragraph.push(rawLine);
  });
  if (fenceLang !== null) {
    nodes.push(<pre key={`pre-${nodes.length}`} data-lang={fenceLang || undefined}><code>{fenceBuf.join("\n")}</code></pre>);
  }
  flushParagraph();
  flushList();
  return nodes;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:https?:\/\/|forge-)[^\s)]+\))/g;

function renderInline(text: string, key: string): ReactNode[] {
  // Escape any leftover tags as literal text so XML stays visible.
  const escaped = text.replace(/<([^>]*)>/g, (_, inner) => `<${inner}>`);
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let n = 0;
  for (const match of escaped.matchAll(INLINE_RE)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(escaped.slice(lastIndex, match.index));
    const token = match[0];
    n += 1;
    if (token.startsWith("`")) {
      parts.push(<code key={`${key}-c${n}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={`${key}-b${n}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={`${key}-i${n}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const href = linkMatch[2];
        const isExternal = href.startsWith("http");
        parts.push(<a key={`${key}-a${n}`} href={isExternal ? href : `#${href}`} target={isExternal ? "_blank" : undefined} rel={isExternal ? "noreferrer" : undefined} onClick={(e) => { if (!isExternal) e.preventDefault(); e.stopPropagation(); }}>{linkMatch[1]}</a>);
      } else {
        parts.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < escaped.length) parts.push(escaped.slice(lastIndex));
  return parts;
}

function formatCompactDate(iso: string | undefined): string { if (!iso) return "—"; const date = new Date(iso); if (Number.isNaN(date.getTime())) return iso; return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

function countDependencies(issue: BeadIssue): number { return issue.dependencies.filter((dependency) => dependency.dependency_type !== "parent-child").length; }

function groupChildrenByEpic(issues: BeadIssue[]): Map<string, BeadIssue[]> { const issueById = new Map(issues.map((issue) => [issue.id, issue])); const groups = new Map<string, BeadIssue[]>(); for (const issue of issues) { const parent = getEpicParentId(issue, issueById); if (!parent) continue; const list = groups.get(parent) ?? []; list.push(issue); groups.set(parent, list); } return groups; }

function getEpicParentId(issue: BeadIssue, issueById: Map<string, BeadIssue>): string | null { if (issue.parent_id && issueById.get(issue.parent_id)?.issue_type === "epic") return issue.parent_id; const parentDependency = issue.dependencies.find((dependency) => dependency.dependency_type === "parent-child" && issueById.get(dependency.id)?.issue_type === "epic"); return parentDependency?.id ?? null; }

function EmptyFeed() { return <div className="bead-empty-note">No issues</div>; }

// ── Dependency display ────────────────────────────────────────────────────────

const DEP_KIND_LABEL: Record<string, string> = {
  blocks: "blocks",
  blocked_by: "blocked by",
  parent: "parent",
  "parent-child": "parent",
  related: "related",
  "discovered-from": "discovered from",
};

const DEP_KIND_GLYPH: Record<string, string> = {
  blocks: "↪",
  blocked_by: "↩",
  parent: "⊃",
  "parent-child": "⊃",
  related: "•",
  "discovered-from": "↑",
};

const DEP_STATUS_ICON: Record<string, string> = {
  closed: "✓",
  open: "○",
  in_progress: "◐",
  blocked: "⛔",
  in_review: "↻",
  deferred: "❄",
};

function renderInlineDeps(issue: BeadIssue, fallbackCount: number): ReactNode {
  const visible = issue.dependencies.filter((d) => d.dependency_type !== "parent-child").slice(0, 2);
  if (visible.length === 0) {
    if (fallbackCount === 0) return <span className="bead-row-dep-empty">—</span>;
    return <span>{fallbackCount} deps</span>;
  }
  const total = issue.dependencies.filter((d) => d.dependency_type !== "parent-child").length;
  const more = total - visible.length;
  return (
    <span className="bead-row-deps">
      {visible.map((d) => (
        <span key={`row-dep-${d.id}`} className={`bead-row-dep bead-row-dep-${d.dependency_type}`} title={`${DEP_KIND_LABEL[d.dependency_type] ?? d.dependency_type}: ${d.id}`}>
          <span className="bead-row-dep-glyph">{DEP_KIND_GLYPH[d.dependency_type] ?? "·"}</span>
          <span className="bead-row-dep-id">{d.id}</span>
        </span>
      ))}
      {more > 0 && <span className="bead-row-dep-more">+{more}</span>}
    </span>
  );
}

function DependencyTree({ issue, dependencies, childDeps, issueById }: { issue: BeadIssue; dependencies: BeadDependency[]; childDeps: BeadDependency[]; issueById: Map<string, BeadIssue>; }) {
  const grouped = useMemo(() => {
    const out = new Map<string, BeadDependency[]>();
    for (const d of dependencies) {
      const list = out.get(d.dependency_type) ?? [];
      list.push(d);
      out.set(d.dependency_type, list);
    }
    return out;
  }, [dependencies]);
  const order: Array<string> = ["parent", "parent-child", "blocked_by", "blocks", "discovered-from", "related"];
  const resolveTitle = (d: BeadDependency) => d.title?.trim() ? d.title : (issueById.get(d.id)?.title ?? "");
  const resolveStatus = (d: BeadDependency) => issueById.get(d.id)?.status ?? d.status;
  return (
    <div className="bead-dep-tree" role="tree">
      <div className="bead-dep-tree-root">
        <span className="bead-dep-tree-status">{DEP_STATUS_ICON[issue.status] ?? "•"}</span>
        <span className="bead-dep-tree-id" title={issue.id}>{issue.id}</span>
        <span className="bead-dep-tree-title" title={issue.title}>{issue.title}</span>
        <span className="bead-dep-tree-kind">[root]</span>
      </div>
      {order.flatMap((kind) => {
        const list = grouped.get(kind);
        if (!list || list.length === 0) return [];
        return list.map((d) => {
          const title = resolveTitle(d);
          const status = resolveStatus(d);
          return (
            <div key={`tree-${kind}-${d.id}`} className="bead-dep-tree-node">
              <span className="bead-dep-tree-connector">└─</span>
              <span className="bead-dep-tree-status">{DEP_STATUS_ICON[status] ?? "•"}</span>
              <span className="bead-dep-tree-id" title={d.id}>{d.id}</span>
              <span className="bead-dep-tree-title" title={title}>{title || <span className="bead-empty-note">—</span>}</span>
              <span className="bead-dep-tree-kind">[{DEP_KIND_LABEL[d.dependency_type] ?? d.dependency_type}]</span>
            </div>
          );
        });
      })}
      {childDeps.map((c) => {
        const title = resolveTitle(c);
        const status = resolveStatus(c);
        return (
          <div key={`tree-child-${c.id}`} className="bead-dep-tree-node">
            <span className="bead-dep-tree-connector">└─</span>
            <span className="bead-dep-tree-status">{DEP_STATUS_ICON[status] ?? "•"}</span>
            <span className="bead-dep-tree-id" title={c.id}>{c.id}</span>
            <span className="bead-dep-tree-title" title={title}>{title || <span className="bead-empty-note">—</span>}</span>
            <span className="bead-dep-tree-kind">[child]</span>
          </div>
        );
      })}
    </div>
  );
}
