/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRightIcon, ChevronDownIcon, IssueOpenedIcon, MilestoneIcon, NorthStarIcon, ProjectIcon, ToolsIcon, DependabotIcon, GitPullRequestIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail, Interaction } from "../../../types/beads.ts";
import { substrateApi as api } from "../../lib/substrate-api.ts";
import { SpecialistOwnerBadge } from "./SpecialistOwnerBadge.tsx";
import { useSpecialistHistory } from "../../hooks/useSpecialistHistory.ts";
import type { SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";

export interface IssuePrLink {
  number: number;
  repo: string;
  url: string | null;
  state: string;
}

interface IssueFeedProps {
  issues: BeadIssue[];
  closedIssues?: BeadIssue[];
  selectedIssueId: string | null;
  selectedIssueDetail: BeadIssueDetail | null;
  loadingDetailId: string | null;
  onIssueSelect: (issue: BeadIssue) => void;
  onIssueOpen?: (issue: BeadIssue) => void;
  getAgent?: (issueId: string) => string | null;
  projectId: string | null;
  prByIssueId?: Map<string, IssuePrLink>;
  specialistByIssueId?: Map<string, SpecialistOwnershipJob>;
}

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

export type FeedItem =
  | { kind: "empty" }
  | { kind: "in-progress-header"; count: number }
  | { kind: "in-progress-empty" }
  | { kind: "open-header"; count: number; readyCount: number }
  | { kind: "closed-header"; count: number }
  | { kind: "issue"; issue: BeadIssue; depth: number; childCount: number; relation: "parent" | "epic" | "blocked" };

export function IssueFeed({ issues, closedIssues = [], selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, onIssueOpen, getAgent, projectId, prByIssueId, specialistByIssueId }: IssueFeedProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [showOpen, setShowOpen] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const allIssues = useMemo(() => [...issues, ...closedIssues], [closedIssues, issues]);
  const issueById = useMemo(() => new Map(allIssues.map((issue) => [issue.id, issue])), [allIssues]);
  const blockingChildren = useMemo(() => groupChildrenByBlocker(issues, issueById), [issueById, issues]);
  const blockedChildIds = useMemo(() => getGroupedChildIds(blockingChildren), [blockingChildren]);
  const activeChildren = useMemo(() => groupChildrenByParent(issues, issueById, blockedChildIds), [blockedChildIds, issueById, issues]);
  const closedChildren = useMemo(() => groupChildrenByParent(closedIssues, issueById, new Set()), [closedIssues, issueById]);
  const topLevelIssues = useMemo(() => issues.filter((issue) => !blockedChildIds.has(issue.id) && !getParentId(issue, issueById)), [blockedChildIds, issueById, issues]);
  const inProgressIssues = useMemo(
    () => issues.filter((issue) => issue.status === "in_progress").sort((a, b) => String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at))),
    [issues],
  );
  const readyCount = useMemo(() => issues.filter((issue) => getDisplayStatus(issue) === "open").length, [issues]);
  const completedIssues = useMemo(
    () => closedIssues.filter((issue) => !getParentId(issue, issueById)).sort((a, b) => getCompletedAt(b).localeCompare(getCompletedAt(a))),
    [closedIssues, issueById],
  );
  const items = useMemo<FeedItem[]>(() => {
    const next: FeedItem[] = [{ kind: "in-progress-header", count: inProgressIssues.length }];
    if (inProgressIssues.length === 0) next.push({ kind: "in-progress-empty" });
    for (const issue of inProgressIssues) next.push({ kind: "issue", issue, depth: 0, relation: "parent", childCount: 0 });
    next.push({ kind: "open-header", count: issues.length, readyCount });
    if (topLevelIssues.length === 0 && completedIssues.length === 0 && inProgressIssues.length === 0) return [...next, { kind: "empty" }];
    if (showOpen) {
      for (const issue of topLevelIssues) {
        appendIssueTree(next, issue, activeChildren, blockingChildren, 0, "parent");
      }
    }
    next.push({ kind: "closed-header", count: closedIssues.length });
    if (showClosed) {
      for (const issue of completedIssues) appendIssueTree(next, issue, closedChildren, new Map(), 0, "parent");
    }
    return next;
  }, [activeChildren, blockingChildren, closedChildren, closedIssues.length, completedIssues, inProgressIssues, issues.length, readyCount, showClosed, showOpen, topLevelIssues]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => getFeedItemKey(items[index]),
    estimateSize: (index) => {
      const item = items[index];
      if (item.kind === "in-progress-header" || item.kind === "open-header" || item.kind === "closed-header") return 28;
      if (item.kind === "in-progress-empty" || item.kind === "empty") return 32;
      return item.issue.id === selectedIssueId ? 260 : 52;
    },
    overscan: 8,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  return (
    <div ref={parentRef} className="bead-feed" style={{ height: "100%", overflowY: "auto" }}>
      <div className="module-list" style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              ref={rowVirtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vRow.start}px)` }}
            >
              {item.kind === "empty" ? (
                <EmptyFeed />
              ) : item.kind === "in-progress-empty" ? (
                <div className="feed-section-empty">no in_progress issues...</div>
              ) : item.kind === "in-progress-header" ? (
                <div className="feed-section-title"><span>▸ in_progress:{item.count}</span></div>
              ) : item.kind === "open-header" ? (
                <button type="button" className="feed-section-title feed-section-toggle" onClick={() => setShowOpen((value) => !value)} aria-expanded={showOpen}>
                  <span>{showOpen ? "▾" : "▸"} open:{item.count}, ready:{item.readyCount}</span>
                </button>
              ) : item.kind === "closed-header" ? (
                <button type="button" className="feed-section-title feed-section-toggle" onClick={() => setShowClosed((value) => !value)} aria-expanded={showClosed}>
                  <span>{showClosed ? "▾" : "▸"} closed:{item.count}</span>
                </button>
              ) : (
                <IssueRow
                  issue={item.issue}
                  detail={selectedIssueId === item.issue.id ? selectedIssueDetail : null}
                  isExpanded={selectedIssueId === item.issue.id}
                  isLoadingDetail={loadingDetailId === item.issue.id}
                  agent={getAgent?.(item.issue.id) ?? null}
                  dependencyCount={countDependencies(item.issue)}
                  childCount={item.childCount}
                  onClick={() => onIssueSelect(item.issue)}
                  onOpen={() => onIssueOpen?.(item.issue)}
                  depth={item.depth}
                  relation={item.relation}
                  projectId={projectId}
                  issueById={issueById}
                  prLink={prByIssueId?.get(item.issue.id) ?? null}
                  specialistJob={specialistByIssueId?.get(item.issue.id) ?? null}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


export function getFeedItemKey(item: FeedItem): string {
  if (item.kind === "issue") return `issue:${item.issue.id}`;
  return item.kind;
}

export function IssueRow({ issue, detail, isExpanded, isLoadingDetail, agent, dependencyCount, childCount, onClick, onOpen, depth = 0, relation = "parent", projectId, issueById, prLink = null, specialistJob = null }: { issue: BeadIssue; detail: BeadIssueDetail | null; isExpanded: boolean; isLoadingDetail: boolean; agent: string | null; dependencyCount: number; childCount: number; onClick: () => void; onOpen: () => void; depth?: number; relation?: "parent" | "epic" | "blocked"; projectId: string | null; issueById: Map<string, BeadIssue>; prLink?: IssuePrLink | null; specialistJob?: SpecialistOwnershipJob | null; }) {
  const isEpic = issue.issue_type === "epic";
  const displayStatus = getDisplayStatus(issue);
  const type = TYPE_CONFIG[String(issue.issue_type)] ?? { label: String(issue.issue_type), icon: IssueOpenedIcon, color: "var(--text-muted)" };
  const statusLabel = (STATUS_LABELS[displayStatus] ?? displayStatus).toLowerCase();

  return (
    <article data-bead-id={issue.id} className={`row ${displayStatus} ${isEpic ? "epic" : ""} ${isExpanded ? "is-expanded" : ""} ${depth > 0 ? "is-child" : ""} ${relation === "blocked" ? "is-blocked-child" : relation === "epic" ? "is-epic-child" : "is-parent-child"}`} style={{ "--bead-depth": depth } as CSSProperties}>
      <button type="button" className="row-main" onClick={onClick} aria-expanded={isExpanded} aria-controls={`issue-dossier-${issue.id}`}>
        <span className="issue-identity"><span className="id">{issue.id}</span><span className="identity-separator">/</span><span className="title">{issue.title}</span></span>
        <span className="issue-classification">
          <span className="priority-mark" style={{ color: type.color }}>P{issue.priority}</span>
          <span className="type-mark" style={{ color: type.color }}>{type.label}</span>
          <span className="state">{statusLabel}</span>
          <span className="meta-item">{formatCompactDate(issue.updated_at)}</span>
          {childCount > 0 && <><span className="identity-separator">/</span><span className="meta-item">{childCount} children</span></>}
          {dependencyCount > 0 && renderRelationshipGroups(issue, dependencyCount, issueById)}
          {prLink && (
            <>
              <span className="identity-separator">/</span>
              <a
                href={prLink.url ?? `https://github.com/${prLink.repo}/pull/${prLink.number}`}
                target="_blank"
                rel="noreferrer"
                className="pr-link-badge"
                title={`${prLink.repo}#${prLink.number}`}
                onClick={(e) => e.stopPropagation()}
              >
                <GitPullRequestIcon size={10} /> #{prLink.number}
              </a>
            </>
          )}
          {agent && <><span className="identity-separator">/</span><span className="agent-badge"><DependabotIcon size={10} /> {agent}</span></>}
          <SpecialistHistoryChip beadId={issue.id} />
          {specialistJob && <SpecialistOwnerBadge job={specialistJob} />}
        </span>
      </button>
      <button type="button" className="chev" onClick={onOpen} aria-label={`open ${issue.id} side drawer`}>{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}</button>
      {isExpanded && <IssueDossier id={`issue-dossier-${issue.id}`} detail={detail} issue={issue} loading={isLoadingDetail} projectId={projectId} issueById={issueById} />}
    </article>
  );
}

export function IssueDossier({ id, detail, issue, loading, projectId, issueById }: { id: string; detail: BeadIssueDetail | null; issue: BeadIssue; loading: boolean; projectId: string | null; issueById: Map<string, BeadIssue>; }) {
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const specialistHistory = useSpecialistHistory(issue.id);

  useEffect(() => {
    let cancelled = false;
    async function loadInteractions() {
      if (!projectId) return;
      try {
        const data = await api.listInteractions(projectId, issue.id);
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

  const allDeps = detail?.dependencies ?? issue.dependencies;
  const related = (detail?.related_ids ?? issue.related_ids ?? []);
  const children = detail?.children ?? [];
  const labels = detail?.labels ?? issue.labels ?? [];
  return (
    <section id={id} className="bead-expanded-body">
      <div className="bead-expanded-stack">
        <div className="bead-dossier-meta-strip">
          <span><b>Status</b><strong>{STATUS_LABELS[getDisplayStatus(issue)] ?? getDisplayStatus(issue)}</strong></span>
          <span><b>Priority</b><strong>P{issue.priority}</strong></span>
          <span><b>Type</b><strong>{TYPE_CONFIG[String(issue.issue_type)]?.label ?? issue.issue_type}</strong></span>
          {issue.owner && <span><b>Owner</b><strong>{issue.owner}</strong></span>}
          <span><b>Created</b><strong>{formatCompactDate(issue.created_at)}</strong></span>
          <span><b>Updated</b><strong>{formatCompactDate(issue.updated_at)}</strong></span>
          {issue.closed_at && <span><b>Closed</b><strong>{formatCompactDate(issue.closed_at)}</strong></span>}
        </div>
        <DossierSection title="Description"><SafeMarkdown value={detail?.description ?? issue.description} empty="No description." /></DossierSection>
        {specialistHistory.count > 0 && (
          <DossierSection title="SPECIALIST ACTIVITY">
            <div className="bead-specialist-activity" role="list">
              {specialistHistory.jobs.map((job) => <SpecialistHistoryRow key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} />)}
            </div>
          </DossierSection>
        )}
        {(detail?.notes ?? issue.notes) && (
          <DossierSection title="Notes"><SafeMarkdown value={detail?.notes ?? issue.notes} empty="No notes." /></DossierSection>
        )}
        {labels.length > 0 && (
          <DossierSection title="Labels"><div className="bead-label-strip">{labels.map((l) => <span key={l} className="bead-label-chip">{l}</span>)}</div></DossierSection>
        )}
        {related.length > 0 && (
          <DossierSection title="Related">
            <ul className="bead-dep-list">{related.map((rid) => <li key={`rel-${rid}`}><span className="bead-dep-id">{rid}</span></li>)}</ul>
          </DossierSection>
        )}
        {interactions.length > 0 && (
          <DossierSection title="Audit log">
            <div className="bead-audit-log">
              {interactions.map((interaction) => <div key={interaction.id} className="bead-audit-item"><span className="bead-audit-kind">{interaction.kind}</span><span>{interaction.actor}</span><span>{formatCompactDate(interaction.created_at)}</span>{interaction.model && <span>{interaction.model}</span>}</div>)}
            </div>
          </DossierSection>
        )}
        {(allDeps.length > 0 || children.length > 0) && (
          <DossierSection title="Dependency tree">
            <DependencyTree issue={issue} dependencies={allDeps} childDeps={children} issueById={issueById} />
          </DossierSection>
        )}
      </div>
    </section>
  );
}

export function DossierSection({ title, children }: { title: string; children: ReactNode }) { return <section className="bead-expanded-section"><div className="bead-section-title">{title}</div>{children}</section>; }

export function SpecialistHistoryChip({ beadId }: { beadId: string }) {
  const { count } = useSpecialistHistory(beadId);
  if (count === 0) return null;
  return <span className="meta-item specialist-runs-chip">· {count} run{count === 1 ? "" : "s"}</span>;
}

function SpecialistHistoryRow({ job }: { job: import("../../hooks/useSpecialistHistory.ts").SpecialistHistoryJob }) {
  const [open, setOpen] = useState(false);
  const excerpt = truncateExcerpt(job.lastOutput);
  return (
    <details className="bead-specialist-activity-row" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{statusIcon(job.status)}</span>
        <span>{job.specialist ?? job.chainKind ?? "—"}</span>
        <span>{job.status}</span>
        <span>{shortId(job.jobId)}</span>
        <span>{formatElapsed(job.updatedAt)}</span>
        <span>{excerpt || job.status}</span>
      </summary>
      {job.lastOutput ? <div className="bead-specialist-activity-output">{job.lastOutput}</div> : null}
    </details>
  );
}

function statusIcon(status: string): string {
  if (status === "done") return "✓";
  if (status === "error") return "✕";
  if (status === "cancelled") return "↯";
  if (status === "running" || status === "starting" || status === "waiting") return "●";
  return "·";
}

function shortId(id: string | null): string { return id ? id.slice(0, 8) : "—"; }

function truncateExcerpt(value: string | null): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length <= 80) return text;
  return `${text.slice(0, 79)}…`;
}

function formatElapsed(updatedAt: string): string { const delta = Date.now() - Date.parse(updatedAt); if (!Number.isFinite(delta) || delta < 0) return "now"; const minutes = Math.floor(delta / 60000); if (minutes < 1) return "now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return `${Math.floor(hours / 24)}d`; }

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
    .replace(/\son\w+='[^']*'/gi, "")
    // JSON-escaped newlines from some bd sources: convert literal "\n" / "\t" to real characters
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "    ");
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

function getCompletedAt(issue: BeadIssue): string { return issue.closed_at ?? issue.updated_at ?? issue.created_at; }

function getDisplayStatus(issue: BeadIssue): string {
  if (issue.status !== "open") return issue.status;
  return hasUnresolvedBlocker(issue) ? "blocked" : "open";
}

function hasUnresolvedBlocker(issue: BeadIssue): boolean {
  return issue.dependencies.some((dependency) =>
    (dependency.dependency_type === "blocked_by" || dependency.dependency_type === "blocks")
    && dependency.status !== "closed",
  );
}

export function countDependencies(issue: BeadIssue): number { return issue.dependencies.filter((dependency) => dependency.dependency_type !== "parent-child").length; }

function appendIssueTree(out: FeedItem[], issue: BeadIssue, childrenByParent: Map<string, BeadIssue[]>, childrenByBlocker: Map<string, BeadIssue[]>, depth: number, relation: "parent" | "epic" | "blocked", seen = new Set<string>()): void {
  if (seen.has(issue.id)) return;
  const nextSeen = new Set(seen).add(issue.id);
  const blockedChildren = childrenByBlocker.get(issue.id) ?? [];
  const parentChildren = childrenByParent.get(issue.id) ?? [];
  const inEpicTree = relation === "epic" || issue.issue_type === "epic";
  out.push({ kind: "issue", issue, depth, relation, childCount: blockedChildren.length + parentChildren.length });
  for (const child of [...blockedChildren].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
    appendIssueTree(out, child, childrenByParent, childrenByBlocker, depth + 1, inEpicTree ? "epic" : "blocked", nextSeen);
  }
  for (const child of [...parentChildren].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
    appendIssueTree(out, child, childrenByParent, childrenByBlocker, depth + 1, inEpicTree ? "epic" : "parent", nextSeen);
  }
}

function groupChildrenByBlocker(issues: BeadIssue[], issueById: Map<string, BeadIssue>): Map<string, BeadIssue[]> {
  const visible = new Set(issues.map((issue) => issue.id));
  const groups = new Map<string, BeadIssue[]>();
  const activeById = new Map(issues.map((issue) => [issue.id, issue]));

  for (const issue of issues) {
    const blockers = issue.dependencies
      .filter((dependency) =>
        (dependency.dependency_type === "blocked_by" || dependency.dependency_type === "blocks")
        && dependency.status !== "closed"
        && visible.has(dependency.id)
        && dependency.id !== issue.id,
      )
      .map((dependency) => activeById.get(dependency.id))
      .filter((blocker): blocker is BeadIssue => Boolean(blocker));
    const primary = choosePrimaryBlocker(issue, blockers, issueById);
    if (!primary) continue;
    const list = groups.get(primary.id) ?? [];
    if (!list.some((child) => child.id === issue.id)) list.push(issue);
    groups.set(primary.id, list);
  }
  return groups;
}

function choosePrimaryBlocker(issue: BeadIssue, blockers: BeadIssue[], issueById: Map<string, BeadIssue>): BeadIssue | null {
  if (blockers.length === 0) return null;
  const issueParent = getParentId(issue, issueById);
  return [...blockers].sort((a, b) => {
    const aSameParent = issueParent && getParentId(a, issueById) === issueParent ? 1 : 0;
    const bSameParent = issueParent && getParentId(b, issueById) === issueParent ? 1 : 0;
    if (aSameParent !== bSameParent) return bSameParent - aSameParent;
    if (a.priority !== b.priority) return Number(a.priority) - Number(b.priority);
    const byUpdated = String(b.updated_at ?? b.created_at).localeCompare(String(a.updated_at ?? a.created_at));
    if (byUpdated !== 0) return byUpdated;
    return a.id.localeCompare(b.id);
  })[0] ?? null;
}

function getGroupedChildIds(groups: Map<string, BeadIssue[]>): Set<string> {
  return new Set([...groups.values()].flat().map((issue) => issue.id));
}

function groupChildrenByParent(issues: BeadIssue[], issueById: Map<string, BeadIssue>, blockedChildIds: Set<string>): Map<string, BeadIssue[]> {
  const groups = new Map<string, BeadIssue[]>();
  for (const issue of issues) {
    if (blockedChildIds.has(issue.id)) continue;
    const parent = getParentId(issue, issueById);
    if (!parent) continue;
    const list = groups.get(parent) ?? [];
    list.push(issue);
    groups.set(parent, list);
  }
  return groups;
}

function getParentId(issue: BeadIssue, issueById: Map<string, BeadIssue>): string | null {
  if (issue.parent_id && issueById.has(issue.parent_id)) return issue.parent_id;
  const parentDependency = issue.dependencies.find((dependency) =>
    (dependency.dependency_type === "parent-child" || dependency.dependency_type === "parent")
    && issueById.has(dependency.id),
  );
  return parentDependency?.id ?? null;
}

function EmptyFeed() { return <div className="bead-empty-note">No issues</div>; }

// ── Dependency display ────────────────────────────────────────────────────────

const DEP_KIND_LABEL: Record<string, string> = {
  blocks: "blocks",
  blocked_by: "blocked by",
  tracks: "tracks",
  related: "related",
  "relates-to": "related",
  parent: "parent",
  "parent-child": "parent",
  "discovered-from": "discovered from",
  until: "until",
  "caused-by": "caused by",
  validates: "validates",
  supersedes: "supersedes",
};

const DEP_KIND_GLYPH: Record<string, string> = {
  blocks: "↪",
  blocked_by: "↩",
  tracks: "◌",
  related: "•",
  "relates-to": "•",
  parent: "⊃",
  "parent-child": "⊃",
  "discovered-from": "↑",
  until: "⌛",
  "caused-by": "⚠",
  validates: "✓",
  supersedes: "⤴",
};

const DEP_STATUS_ICON: Record<string, string> = {
  closed: "✓",
  open: "○",
  in_progress: "◐",
  blocked: "⛔",
  in_review: "↻",
  deferred: "❄",
};

function renderRelationshipGroups(issue: BeadIssue, fallbackCount: number, issueById: Map<string, BeadIssue>): ReactNode {
  const dependencies = issue.dependencies.filter((d) => d.dependency_type !== "parent-child");
  if (dependencies.length === 0) {
    if (fallbackCount === 0) return <span className="bead-row-dep-empty">—</span>;
    return <><span className="identity-separator">/</span><span className="meta-item">{fallbackCount} deps</span></>;
  }
  const order = ["blocked_by", "blocks", "tracks", "discovered-from", "until", "caused-by", "validates", "supersedes", "related", "relates-to", "parent"];
  const grouped = dependencies.reduce((out, dependency) => {
    const list = out.get(dependency.dependency_type) ?? [];
    list.push(dependency);
    out.set(dependency.dependency_type, list);
    return out;
  }, new Map<string, BeadDependency[]>());
  const kinds = [...order, ...[...grouped.keys()].filter((kind) => !order.includes(kind)).sort()].filter((kind) => grouped.has(kind));
  const getDependencyTitle = (dependency: BeadDependency) => {
    const relatedIssue = issueById.get(dependency.id);
    const title = relatedIssue?.title?.trim() || dependency.title?.trim();
    if (!title) return `${DEP_KIND_LABEL[dependency.dependency_type] ?? dependency.dependency_type}: ${dependency.id}`;
    const relatedType = relatedIssue ? TYPE_CONFIG[String(relatedIssue.issue_type)] : null;
    const summary = relatedIssue && relatedType ? ` — P${relatedIssue.priority} ${relatedType.label.toLowerCase()}` : "";
    return `${DEP_KIND_LABEL[dependency.dependency_type] ?? dependency.dependency_type}: ${dependency.id} — ${title}${summary}`;
  };
  return (
    <>
      {kinds.map((kind) => (
        <span key={`row-dep-group-${kind}`} className="bead-row-dep-group">
          <span className="bead-row-dep-kind">{DEP_KIND_LABEL[kind] ?? kind}:</span>
          <span className="bead-row-deps">
            {grouped.get(kind)!.map((d) => (
              <span key={`row-dep-${kind}-${d.id}`} className={`bead-row-dep bead-row-dep-${d.dependency_type}`} title={getDependencyTitle(d)}>
                <span className="bead-row-dep-glyph">{DEP_KIND_GLYPH[d.dependency_type] ?? "·"}</span>
                <span className="bead-row-dep-id">{d.id}</span>
              </span>
            ))}
          </span>
        </span>
      ))}
    </>
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
  const order: Array<string> = ["parent", "parent-child", "blocked_by", "blocks", "tracks", "discovered-from", "until", "caused-by", "validates", "supersedes", "related", "relates-to"];
  const orderedKinds = [...order, ...[...grouped.keys()].filter((kind) => !order.includes(kind)).sort()];
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
      {orderedKinds.flatMap((kind) => {
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
