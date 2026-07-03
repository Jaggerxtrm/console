/**
 * IssueFeed - primary inline issue feed with expandable dossiers
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, ChevronRightIcon, DependabotIcon, GitPullRequestIcon, PulseIcon, SearchIcon, XIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail, Interaction } from "../../../types/beads.ts";
import { substrateApi as api } from "../../lib/beads.ts";
import { TYPE_CONFIG } from "../../lib/type-palette.ts";
import { SpecialistOwnerBadge } from "./SpecialistOwnerBadge.tsx";
import { BeadHeader } from "../specialists/BeadHeader.tsx";
import { useSpecialistHistory } from "../../hooks/useSpecialistHistory.ts";
import type { SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import { useShellStore } from "../../stores/shell.ts";
import { filterIssuesForFeed, type FeedSearchMatch } from "./feedSearch.ts";

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

const FEED_SORTS = [
  { value: "updated-desc", label: "updated newest" },
  { value: "updated-asc", label: "updated oldest" },
  { value: "created-desc", label: "created newest" },
  { value: "created-asc", label: "created oldest" },
  { value: "priority-asc", label: "priority high" },
  { value: "priority-desc", label: "priority low" },
  { value: "id-asc", label: "id" },
] as const;

type FeedSort = typeof FEED_SORTS[number]["value"];
type FeedStatusFilter = "all" | "open" | "in_progress" | "blocked" | "in_review" | "deferred" | "closed";
type FeedPriorityFilter = "all" | `${number}`;
type FeedTypeFilter = "all" | string;

export type FeedItem =
  | { kind: "empty" }
  | { kind: "in-progress-header"; count: number }
  | { kind: "in-progress-empty" }
  | { kind: "open-header"; count: number; readyCount: number }
  | { kind: "closed-header"; count: number }
  | { kind: "issue"; issue: BeadIssue; depth: number; childCount: number; relation: "parent" | "epic" | "blocked" };

export function IssueFeed({ issues, closedIssues = [], selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, onIssueOpen, getAgent, projectId, prByIssueId, specialistByIssueId }: IssueFeedProps) {
  const openSidebar = useShellStore((state) => state.openSidebar);
  const handleSpecialistOpen = (beadId: string, specialistJob: SpecialistOwnershipJob | null) => {
    if (!specialistJob) return;
    const previous = useShellStore.getState().sidebar;
    logClientEvent("chip.click", { source: "feed_chip", beadId, jobId: specialistJob.jobId ?? null });
    openSidebar({ beadId, jobId: specialistJob.jobId ?? undefined });
    logClientEvent("chip.sidebar.dispatched", {
      source: "feed_chip",
      beadId,
      jobId: specialistJob.jobId ?? null,
      swap: Boolean(previous.open && previous.beadId !== beadId),
      prevSidebar: previous.open ? { beadId: previous.beadId, jobId: previous.jobId } : null,
    });
  };
  const parentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nextFocusSource = useRef<"click" | "hotkey" | "tab">("tab");
  const closedToggleTouchedRef = useRef(false);
  const [showOpen, setShowOpen] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FeedSort>("updated-desc");
  const [statusFilter, setStatusFilter] = useState<FeedStatusFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<FeedPriorityFilter>("all");
  const [typeFilter, setTypeFilter] = useState<FeedTypeFilter>("all");
  const allIssues = useMemo(() => [...issues, ...closedIssues], [closedIssues, issues]);
  const issueById = useMemo(() => new Map(allIssues.map((issue) => [issue.id, issue])), [allIssues]);
  const searchOpen = useMemo(() => filterIssuesForFeed(issues, query), [issues, query]);
  const searchClosed = useMemo(() => filterIssuesForFeed(closedIssues, query), [closedIssues, query]);
  const searchMatchByIssueId = useMemo(
    () => new Map([...searchOpen.matchByIssueId, ...searchClosed.matchByIssueId]),
    [searchClosed.matchByIssueId, searchOpen.matchByIssueId],
  );
  const typeOptions = useMemo(() => buildTypeOptions(allIssues), [allIssues]);
  const baseOpenIssues = useMemo(() => applyBaseFeedControls(searchOpen.issues, statusFilter, priorityFilter), [priorityFilter, searchOpen.issues, statusFilter]);
  const baseClosedIssues = useMemo(() => applyBaseFeedControls(searchClosed.issues, statusFilter, priorityFilter), [priorityFilter, searchClosed.issues, statusFilter]);
  const baseOpenParentByChild = useMemo(() => buildParentLookup(baseOpenIssues), [baseOpenIssues]);
  const baseClosedParentByChild = useMemo(() => buildParentLookup(baseClosedIssues), [baseClosedIssues]);
  const visibleIssues = useMemo(() => sortIssues(applyTypeFilter(baseOpenIssues, typeFilter, baseOpenParentByChild), sort), [baseOpenIssues, baseOpenParentByChild, sort, typeFilter]);
  const visibleClosedIssues = useMemo(() => sortIssues(applyTypeFilter(baseClosedIssues, typeFilter, baseClosedParentByChild), sort), [baseClosedIssues, baseClosedParentByChild, sort, typeFilter]);
  const searchStats = useMemo(() => ({
    prefixMatchCount: searchOpen.prefixMatchCount + searchClosed.prefixMatchCount,
    titleMatchCount: searchOpen.titleMatchCount + searchClosed.titleMatchCount,
    totalMatches: query.trim() ? searchOpen.totalMatches + searchClosed.totalMatches : allIssues.length,
    durationMs: searchOpen.durationMs + searchClosed.durationMs,
  }), [allIssues.length, query, searchClosed.durationMs, searchClosed.prefixMatchCount, searchClosed.titleMatchCount, searchClosed.totalMatches, searchOpen.durationMs, searchOpen.prefixMatchCount, searchOpen.titleMatchCount, searchOpen.totalMatches]);
  const inProgressIssues = useMemo(
    () => visibleIssues.filter((issue) => issue.status === "in_progress"),
    [visibleIssues],
  );
  const openIssues = useMemo(() => visibleIssues.filter((issue) => issue.status !== "in_progress"), [visibleIssues]);
  const activeParentByChild = useMemo(() => buildParentLookup(openIssues), [openIssues]);
  const closedParentByChild = useMemo(() => buildParentLookup(visibleClosedIssues), [visibleClosedIssues]);
  const blockingChildren = useMemo(() => groupChildrenByBlocker(openIssues, activeParentByChild), [activeParentByChild, openIssues]);
  const blockedChildIds = useMemo(() => getGroupedChildIds(blockingChildren), [blockingChildren]);
  const activeChildren = useMemo(() => groupChildrenByParent(openIssues, activeParentByChild, blockedChildIds), [activeParentByChild, blockedChildIds, openIssues]);
  const closedChildren = useMemo(() => groupChildrenByParent(visibleClosedIssues, closedParentByChild, new Set()), [closedParentByChild, visibleClosedIssues]);
  const topLevelIssues = useMemo(() => openIssues.filter((issue) => !blockedChildIds.has(issue.id) && !getParentId(issue, activeParentByChild)), [activeParentByChild, blockedChildIds, openIssues]);
  const readyCount = useMemo(() => openIssues.filter((issue) => getDisplayStatus(issue) === "open").length, [openIssues]);
  const completedIssues = useMemo(() => visibleClosedIssues.filter((issue) => !getParentId(issue, closedParentByChild)), [closedParentByChild, visibleClosedIssues]);
  const openDependencyCount = useMemo(() => visibleIssues.reduce((count, issue) => count + countDependencies(issue), 0), [visibleIssues]);
  const closedDependencyCount = useMemo(() => visibleClosedIssues.reduce((count, issue) => count + countDependencies(issue), 0), [visibleClosedIssues]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        nextFocusSource.current = "hotkey";
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        event.preventDefault();
        setQuery("");
        searchRef.current?.blur();
        logClientEvent("feed.search.cleared", { source: "esc" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    logClientEvent("feed.search.query_changed", {
      queryLength: trimmed.length,
      prefixMatchCount: searchStats.prefixMatchCount,
      titleMatchCount: searchStats.titleMatchCount,
      totalMatches: searchStats.totalMatches,
      durationMs: searchStats.durationMs,
    });
    if (trimmed && searchStats.totalMatches === 0) logClientEvent("feed.search.empty_result", { query: trimmed });
  }, [query, searchStats.durationMs, searchStats.prefixMatchCount, searchStats.titleMatchCount, searchStats.totalMatches]);

  useEffect(() => {
    if (!query.trim() && searchOpen.issues === issues && searchClosed.issues === closedIssues) {
      logClientEvent("feed.search.identity_preserved", { queryUnchanged: true, issuesIdentity: `${issues.length}:${closedIssues.length}` });
    }
  }, [closedIssues, issues, query, searchClosed.issues, searchOpen.issues]);

  useEffect(() => {
    if (closedToggleTouchedRef.current || showClosed || openDependencyCount > 0 || closedDependencyCount === 0) return;
    setShowClosed(true);
    logClientEvent("feed.closed_history.auto_expanded", { closedIssues: visibleClosedIssues.length, dependencyCount: closedDependencyCount });
  }, [closedDependencyCount, openDependencyCount, showClosed, visibleClosedIssues.length]);

  useEffect(() => {
    if (statusFilter !== "closed") return;
    setShowClosed(true);
  }, [statusFilter]);

  const items = useMemo<FeedItem[]>(() => {
    const next: FeedItem[] = [{ kind: "in-progress-header", count: inProgressIssues.length }];
    if (inProgressIssues.length === 0) next.push({ kind: "in-progress-empty" });
    for (const issue of inProgressIssues) next.push({ kind: "issue", issue, depth: 0, relation: "parent", childCount: 0 });
    next.push({ kind: "open-header", count: openIssues.length, readyCount });
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
  }, [activeChildren, blockingChildren, closedChildren, closedIssues.length, completedIssues, inProgressIssues, openIssues.length, readyCount, showClosed, showOpen, topLevelIssues]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => items[index] ? getFeedItemKey(items[index]) : `pending:${index}`,
    estimateSize: (index) => {
      const item = items[index];
      if (!item) return 52;
      if (item.kind === "in-progress-header" || item.kind === "open-header" || item.kind === "closed-header") return 28;
      if (item.kind === "in-progress-empty" || item.kind === "empty") return 32;
      return item.issue.id === selectedIssueId ? 260 : 52;
    },
    overscan: 8,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
  });

  return (
    <div ref={parentRef} className="bead-feed" style={{ height: "100%", overflowY: "auto" }}>
      <div className="feed-search" role="search" aria-label="Search beads in this project">
        <SearchIcon size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onPointerDown={() => { nextFocusSource.current = "click"; }}
          onFocus={() => {
            logClientEvent("feed.search.focused", { source: nextFocusSource.current });
            nextFocusSource.current = "tab";
          }}
          placeholder="Search id, title, description, notes, labels"
          aria-label="Search beads in this project"
        />
        {query ? (
          <button
            type="button"
            className="feed-search-clear"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
              logClientEvent("feed.search.cleared", { source: "x" });
            }}
            aria-label="Clear bead search"
          >
            <XIcon size={12} />
          </button>
        ) : null}
      </div>
      <div className="feed-controls" aria-label="Feed filters">
        <label>
          <span>sort</span>
          <select value={sort} onChange={(event) => setSort(event.currentTarget.value as FeedSort)} aria-label="Sort beads">
            {FEED_SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as FeedStatusFilter)} aria-label="Filter beads by status">
            <option value="all">all</option>
            <option value="open">ready</option>
            <option value="in_progress">in progress</option>
            <option value="blocked">blocked</option>
            <option value="in_review">in review</option>
            <option value="deferred">deferred</option>
            <option value="closed">closed</option>
          </select>
        </label>
        <label>
          <span>priority</span>
          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.currentTarget.value as FeedPriorityFilter)} aria-label="Filter beads by priority">
            <option value="all">all</option>
            {[0, 1, 2, 3, 4].map((priority) => <option key={priority} value={priority}>P{priority}</option>)}
          </select>
        </label>
        <label>
          <span>type</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value)} aria-label="Filter beads by type">
            <option value="all">all</option>
            {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <span className="feed-control-count">{visibleIssues.length + visibleClosedIssues.length}/{allIssues.length}</span>
      </div>
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
                <div className="feed-section-empty">no in progress issues...</div>
              ) : item.kind === "in-progress-header" ? (
                <div className="feed-section-title">
                  <ChevronRightIcon size={12} aria-hidden="true" />
                  <span>in progress:{item.count}</span>
                </div>
              ) : item.kind === "open-header" ? (
                <button type="button" className="feed-section-title feed-section-toggle" onClick={() => setShowOpen((value) => !value)} aria-expanded={showOpen}>
                  {showOpen ? <ChevronDownIcon size={12} aria-hidden="true" /> : <ChevronRightIcon size={12} aria-hidden="true" />}
                  <span>open:{item.count}, ready:{item.readyCount}</span>
                </button>
              ) : item.kind === "closed-header" ? (
                <button type="button" className="feed-section-title feed-section-toggle" onClick={() => { closedToggleTouchedRef.current = true; setShowClosed((value) => !value); }} aria-expanded={showClosed}>
                  {showClosed ? <ChevronDownIcon size={12} aria-hidden="true" /> : <ChevronRightIcon size={12} aria-hidden="true" />}
                  <span>closed:{item.count}</span>
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
                  onSpecialistOpen={() => handleSpecialistOpen(item.issue.id, specialistByIssueId?.get(item.issue.id) ?? null)}
                  depth={item.depth}
                  relation={item.relation}
                  projectId={projectId}
                  issueById={issueById}
                  prLink={prByIssueId?.get(item.issue.id) ?? null}
                  specialistJob={specialistByIssueId?.get(item.issue.id) ?? null}
                  searchMatch={query.trim() ? searchMatchByIssueId.get(item.issue.id) ?? null : null}
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

export function IssueRow({ issue, detail, isExpanded, isLoadingDetail, agent, dependencyCount, childCount, onClick, onOpen, onSpecialistOpen, depth = 0, relation = "parent", projectId, issueById, prLink = null, specialistJob = null, searchMatch = null }: { issue: BeadIssue; detail: BeadIssueDetail | null; isExpanded: boolean; isLoadingDetail: boolean; agent: string | null; dependencyCount: number; childCount: number; onClick: () => void; onOpen: () => void; onSpecialistOpen: () => void; depth?: number; relation?: "parent" | "epic" | "blocked"; projectId: string | null; issueById: Map<string, BeadIssue>; prLink?: IssuePrLink | null; specialistJob?: SpecialistOwnershipJob | null; searchMatch?: FeedSearchMatch | null; }) {
  const isEpic = issue.issue_type === "epic";
  const displayStatus = getDisplayStatus(issue);
  const type = getTypeConfig(issue.issue_type);
  const statusLabel = (STATUS_LABELS[displayStatus] ?? displayStatus).toLowerCase();

  return (
    <article data-bead-id={issue.id} className={`row ${displayStatus} ${isEpic ? "epic" : ""} ${isExpanded ? "is-expanded" : ""} ${depth > 0 ? "is-child" : ""} ${relation === "blocked" ? "is-blocked-child" : relation === "epic" ? "is-epic-child" : "is-parent-child"}`} style={{ "--bead-depth": depth } as CSSProperties}>
      <button type="button" className="row-main" onClick={() => { onClick(); onOpen(); }} aria-expanded={isExpanded} aria-controls={`issue-dossier-${issue.id}`}>
        <span className="issue-identity"><span className="id">{issue.id}</span><span className="identity-separator">/</span><span className="title">{issue.title}</span></span>
        <span className="issue-classification">
          <span className="priority-mark" style={{ color: type.color }}>P{issue.priority}</span>
          <span className="type-mark" style={{ color: type.color }}>{type.label}</span>
          <span className="state">{statusLabel}</span>
          <span className="meta-item">{formatCompactDate(issue.updated_at)}</span>
          {searchMatch ? <><span className="identity-separator">/</span><span className={`feed-match-reason feed-match-${searchMatch.reason}`} title={searchMatch.snippet}>{formatSearchMatch(searchMatch)}</span></> : null}
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
          {specialistJob && <SpecialistOwnerBadge job={specialistJob} onClick={onSpecialistOpen} />}
        </span>
      </button>
      <button type="button" className="activity-btn" onClick={onOpen} aria-label={`Open ${issue.id} activity inspector`} title="Open activity inspector">
        <PulseIcon size={13} />
      </button>
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
        <BeadHeader issue={issue} detail={detail} showIdentity={false} />
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
  const role = job.specialist ?? job.chainKind ?? "specialist";
  return (
    <details className="bead-specialist-activity-row" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={`bead-specialist-status bead-specialist-status-${statusToken(job.status)}`}>{formatStatusLabel(job.status)}</span>
        <span className="bead-specialist-role">{role}</span>
        {job.jobId ? <span className="bead-specialist-job-id">{shortId(job.jobId)}</span> : null}
        <span className="bead-specialist-elapsed">{formatElapsed(job.updatedAt)}</span>
        <span className="bead-specialist-excerpt">{excerpt || formatStatusLabel(job.status)}</span>
      </summary>
      {job.lastOutput ? <div className="bead-specialist-activity-output">{job.lastOutput}</div> : null}
    </details>
  );
}

function formatStatusLabel(status: string): string {
  return status.replace(/[_-]+/g, " ").trim() || "unknown";
}

function statusToken(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
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

function formatSearchMatch(match: FeedSearchMatch): string {
  const snippet = truncateExcerpt(match.snippet);
  return snippet ? `${match.label}: ${snippet}` : match.label;
}

function applyBaseFeedControls(issues: BeadIssue[], status: FeedStatusFilter, priority: FeedPriorityFilter): BeadIssue[] {
  return issues.filter((issue) => {
    if (status !== "all" && getDisplayStatus(issue) !== status) return false;
    if (priority !== "all" && Number(issue.priority) !== Number(priority)) return false;
    return true;
  });
}

function buildTypeOptions(issues: BeadIssue[]): string[] {
  const types = new Set<string>();
  for (const issue of issues) {
    if (issue.issue_type) types.add(issue.issue_type);
    for (const dependency of issue.dependencies) {
      if (dependency.issue_type) types.add(dependency.issue_type);
    }
  }
  return [...types].sort();
}

function applyTypeFilter(issues: BeadIssue[], type: FeedTypeFilter, parentByChild: Map<string, string>): BeadIssue[] {
  if (type === "all") return issues;
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  return issues.filter((issue) => issue.issue_type === type || hasAncestorOfType(issue, type, issueById, parentByChild));
}

function hasAncestorOfType(issue: BeadIssue, type: string, issueById: Map<string, BeadIssue>, parentByChild: Map<string, string>): boolean {
  if (issue.dependencies.some((dependency) => isParentRelation(dependency) && dependency.issue_type === type)) return true;
  const seen = new Set<string>([issue.id]);
  let parentId = parentByChild.get(issue.id);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = issueById.get(parentId);
    if (!parent) return false;
    if (parent.issue_type === type) return true;
    parentId = parentByChild.get(parent.id);
  }
  return false;
}

function sortIssues(issues: BeadIssue[], sort: FeedSort): BeadIssue[] {
  return [...issues].sort((a, b) => {
    switch (sort) {
      case "updated-asc":
        return compareTimestamp(a.updated_at ?? a.created_at, b.updated_at ?? b.created_at) || a.id.localeCompare(b.id);
      case "created-desc":
        return compareTimestamp(b.created_at, a.created_at) || a.id.localeCompare(b.id);
      case "created-asc":
        return compareTimestamp(a.created_at, b.created_at) || a.id.localeCompare(b.id);
      case "priority-asc":
        return Number(a.priority) - Number(b.priority) || compareTimestamp(b.updated_at ?? b.created_at, a.updated_at ?? a.created_at) || a.id.localeCompare(b.id);
      case "priority-desc":
        return Number(b.priority) - Number(a.priority) || compareTimestamp(b.updated_at ?? b.created_at, a.updated_at ?? a.created_at) || a.id.localeCompare(b.id);
      case "id-asc":
        return a.id.localeCompare(b.id);
      case "updated-desc":
      default:
        return compareTimestamp(b.updated_at ?? b.created_at, a.updated_at ?? a.created_at) || a.id.localeCompare(b.id);
    }
  });
}

function compareTimestamp(a: string | undefined, b: string | undefined): number {
  const left = toTimestamp(a);
  const right = toTimestamp(b);
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
  if (!Number.isFinite(left)) return -1;
  if (!Number.isFinite(right)) return 1;
  return left - right;
}

function toTimestamp(value: string | undefined): number {
  if (!value) return Number.NaN;
  const text = unquoteTimestamp(value);
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(text);
}

function unquoteTimestamp(value: string): string {
  const text = value.trim();
  if (!text.startsWith("\"") || !text.endsWith("\"")) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed == null ? "" : String(parsed);
  } catch {
    return text.slice(1, -1);
  }
}

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
  for (const child of blockedChildren) {
    appendIssueTree(out, child, childrenByParent, childrenByBlocker, depth + 1, inEpicTree ? "epic" : "blocked", nextSeen);
  }
  for (const child of parentChildren) {
    appendIssueTree(out, child, childrenByParent, childrenByBlocker, depth + 1, inEpicTree ? "epic" : "parent", nextSeen);
  }
}

function groupChildrenByBlocker(issues: BeadIssue[], parentByChild: Map<string, string>): Map<string, BeadIssue[]> {
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
    const primary = choosePrimaryBlocker(issue, blockers, parentByChild);
    if (!primary) continue;
    const list = groups.get(primary.id) ?? [];
    if (!list.some((child) => child.id === issue.id)) list.push(issue);
    groups.set(primary.id, list);
  }
  return groups;
}

function choosePrimaryBlocker(issue: BeadIssue, blockers: BeadIssue[], parentByChild: Map<string, string>): BeadIssue | null {
  if (blockers.length === 0) return null;
  const issueParent = getParentId(issue, parentByChild);
  return [...blockers].sort((a, b) => {
    const aSameParent = issueParent && getParentId(a, parentByChild) === issueParent ? 1 : 0;
    const bSameParent = issueParent && getParentId(b, parentByChild) === issueParent ? 1 : 0;
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

function groupChildrenByParent(issues: BeadIssue[], parentByChild: Map<string, string>, blockedChildIds: Set<string>): Map<string, BeadIssue[]> {
  const groups = new Map<string, BeadIssue[]>();
  for (const issue of issues) {
    if (blockedChildIds.has(issue.id)) continue;
    const parent = getParentId(issue, parentByChild);
    if (!parent) continue;
    const list = groups.get(parent) ?? [];
    list.push(issue);
    groups.set(parent, list);
  }
  return groups;
}

function buildParentLookup(issues: BeadIssue[]): Map<string, string> {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const parentByChild = new Map<string, string>();
  const setParent = (childId: string, parentId: string, explicit = false) => {
    if (childId === parentId || !issueById.has(childId) || !issueById.has(parentId)) return;
    if (explicit || !parentByChild.has(childId)) parentByChild.set(childId, parentId);
  };

  for (const issue of issues) {
    if (issue.parent_id) setParent(issue.id, issue.parent_id, true);
  }

  for (const issue of issues) {
    const inferredParent = inferParentIdFromIssueId(issue.id, issueById);
    if (inferredParent) setParent(issue.id, inferredParent);
  }

  for (const issue of issues) {
    for (const dependency of issue.dependencies) {
      if (!isParentRelation(dependency)) continue;
      const related = issueById.get(dependency.id);
      if (!related) continue;
      if (dependency.dependency_type === "parent") {
        setParent(issue.id, related.id);
      } else if (related.parent_id === issue.id || issue.issue_type === "epic") {
        setParent(related.id, issue.id);
      } else {
        setParent(issue.id, related.id);
      }
    }
  }

  return parentByChild;
}

function isParentRelation(dependency: BeadDependency): boolean {
  return dependency.dependency_type === "parent-child" || dependency.dependency_type === "parent";
}

function inferParentIdFromIssueId(issueId: string, issueById: Map<string, BeadIssue>): string | null {
  let cursor = issueId;
  while (cursor.includes(".")) {
    cursor = cursor.replace(/\.[^.]+$/, "");
    if (issueById.has(cursor)) return cursor;
  }
  return null;
}

function getParentId(issue: BeadIssue, parentByChild: Map<string, string>): string | null {
  return parentByChild.get(issue.id) ?? null;
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
    const relatedType = relatedIssue ? getTypeConfig(relatedIssue.issue_type) : null;
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

function getTypeConfig(issueType: string): { label: string; color: string } {
  return TYPE_CONFIG[issueType as keyof typeof TYPE_CONFIG] ?? { label: issueType, color: "var(--text-muted)" };
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
