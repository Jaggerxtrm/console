import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon, XIcon } from "@primer/octicons-react";
import type { BeadDependency, BeadIssue, BeadIssueDetail, Memory } from "../../../types/beads.ts";
import { useBeadSideDrawer, type BeadInspectorTab } from "../../hooks/useBeadSideDrawer.ts";
import { substrateApi } from "../../lib/beads.ts";
import { useShellStore } from "../../stores/shell.ts";
import { useSpecialistOwnership } from "../../hooks/useSpecialistOwnership.ts";
import { useSpecialistHistory } from "../../hooks/useSpecialistHistory.ts";
import { BeadActivityPane } from "../../components/specialists/BeadActivityPane.tsx";
import { IssueDossier } from "../../components/beads/IssueFeed.tsx";
import { BeadMutationPanel } from "../../components/beads/inline/BeadMutationPanel.tsx";

const TABS: Array<{ id: BeadInspectorTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "lineage", label: "Lineage" },
  { id: "activity", label: "Activity" },
  { id: "evidence", label: "Evidence" },
  { id: "github", label: "GitHub" },
  { id: "memories", label: "Memories" },
  { id: "followups", label: "Followups" },
];

const DRAWER_MIN_WIDTH = 420;
const DRAWER_MAX_WIDTH_RATIO = 0.78;
const DRAWER_DEFAULT_WIDTH_RATIO = 0.5;

export function BeadSideDrawer({ onClose }: { onClose?: () => void } = {}) {
  const beadId = useBeadSideDrawer((s) => s.beadId);
  const jobId = useBeadSideDrawer((s) => s.jobId);
  const chainId = useBeadSideDrawer((s) => s.chainId);
  const projectId = useBeadSideDrawer((s) => s.projectId);
  const issueById = useBeadSideDrawer((s) => s.issueById);
  const fallbackIssue = useBeadSideDrawer((s) => s.fallbackIssue);
  const memories = useBeadSideDrawer((s) => s.memories);
  const tab = useBeadSideDrawer((s) => s.tab);
  const backStack = useBeadSideDrawer((s) => s.backStack);
  const close = useBeadSideDrawer((s) => s.close);
  const back = useBeadSideDrawer((s) => s.back);
  const setTab = useBeadSideDrawer((s) => s.setTab);
  const open = useBeadSideDrawer((s) => s.open);
  const baseIssue = beadId ? issueById.get(beadId) ?? fallbackIssue : null;
  const [localIssue, setLocalIssue] = useState<BeadIssue | null>(null);
  const issue = localIssue?.id === baseIssue?.id ? localIssue : baseIssue;
  const ownership = useSpecialistOwnership(beadId);
  const history = useSpecialistHistory(beadId);
  const [detail, setDetail] = useState<BeadIssueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(() => defaultDrawerWidth());

  useEffect(() => {
    let cancelled = false;
    setLocalIssue(null);
    if (!beadId || !projectId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void substrateApi.getIssue(projectId, beadId).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch(() => {
      if (!cancelled) setDetail(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [beadId, projectId]);

  const handleClose = useCallback(() => {
    onClose?.();
    close();
  }, [close, onClose]);

  const handleKey = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  }, [handleClose]);

  useEffect(() => {
    if (!beadId) return;
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [beadId, handleKey]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    const pointerId = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch {
      // Document listeners below keep drag working when capture is unavailable.
    }
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + startX - moveEvent.clientX;
      setDrawerWidth(clampDrawerWidth(next));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [drawerWidth]);

  const goToFeed = useCallback(() => {
    const shell = useShellStore.getState();
    shell.setSurface("console");
    shell.setTab("feed");
    close();
    queueMicrotask(() => document.querySelector(`[data-bead-id="${CSS.escape(beadId ?? "")}"]`)?.scrollIntoView({ block: "center" }));
  }, [beadId, close]);

  const relatedMemories = useMemo(() => beadId ? memories.filter((memory) => memory.issue_id === beadId || memory.content.includes(beadId)) : [], [beadId, memories]);

  if (!beadId || !issue) return null;

  const tabs = withCounts(TABS, {
    lineage: countLineage(issue, detail),
    activity: history.count,
    evidence: history.count,
    memories: relatedMemories.length,
    followups: countFollowups(issue, detail),
  });

  return createPortal(
    <div className="bead-side-drawer-backdrop" aria-hidden="false">
      <aside className="bead-side-drawer" role="complementary" aria-label="Issue inspector" style={{ width: `${drawerWidth}px` }}>
        <button type="button" className="bead-side-drawer-resizer" aria-label="resize bead inspector" onPointerDown={startResize} />
        <header className="bead-side-drawer-header">
          <div className="bead-side-drawer-header-main">
            <div className="bead-side-drawer-breadcrumb" aria-label={`xtrm / issue / ${issue.id}`}>
              <span>xtrm</span>
              <span>/</span>
              <span>issue</span>
              <span>/</span>
              <span>{issue.id}</span>
            </div>
            <div className="bead-side-drawer-headline">
              {backStack.length > 0 ? <button type="button" className="bead-side-drawer-back" aria-label="Back to previous bead" onClick={back}><ArrowLeftIcon size={14} /></button> : null}
              <span className="bead-side-drawer-id">{issue.id}</span>
              <span id="bead-side-drawer-title" className="bead-side-drawer-title">{issue.title}</span>
            </div>
          </div>
          <button type="button" className="bead-side-drawer-close" aria-label="close bead inspector" onClick={handleClose}><XIcon size={14} /></button>
        </header>
        <div className="bead-side-drawer-body">
          <div className="bead-dossier-meta-strip">
            <span><b>Priority</b><strong>P{issue.priority}</strong></span>
            <span><b>Type</b><strong>{String(issue.issue_type)}</strong></span>
            <span><b>Status</b><strong>{issue.status}</strong></span>
            {ownership ? <span><b>Owner</b><strong>{ownership.role}</strong></span> : null}
            {history.count > 0 ? <span><b>History</b><strong>{history.count} run{history.count === 1 ? "" : "s"}</strong></span> : null}
          </div>
          <nav className="bead-inspector-tabs" role="tablist" aria-label="Bead inspector tabs">
            {tabs.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "bead-inspector-tab is-active" : "bead-inspector-tab"} onClick={() => setTab(item.id)}>
                <span>{item.label}</span>
                {item.count ? <b>{item.count}</b> : null}
              </button>
            ))}
          </nav>
          <div className="bead-inspector-panel" role="tabpanel">
            {renderTab(tab, {
              issue,
              detail,
              loading,
              projectId,
              issueById,
              memories: relatedMemories,
              history,
              jobId,
              chainId,
              onOpenBead: (nextIssue) => open({ beadId: nextIssue.id, issue: nextIssue }),
              onIssueChange: setLocalIssue,
              onDeleted: handleClose,
              onSelectActivity: () => setTab("activity"),
            })}
          </div>
        </div>
        <footer className="bead-side-drawer-footer">
          <button type="button" className="ide-btn" onClick={goToFeed}>Open in Issues</button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function defaultDrawerWidth(): number {
  if (typeof window === "undefined") return 720;
  return clampDrawerWidth(window.innerWidth * DRAWER_DEFAULT_WIDTH_RATIO);
}

function clampDrawerWidth(value: number): number {
  if (typeof window === "undefined") return value;
  const min = Math.min(DRAWER_MIN_WIDTH, window.innerWidth);
  const max = Math.max(min, Math.floor(window.innerWidth * DRAWER_MAX_WIDTH_RATIO));
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function renderTab(tab: BeadInspectorTab, props: {
  issue: BeadIssue;
  detail: BeadIssueDetail | null;
  loading: boolean;
  projectId: string | null;
  onIssueChange: (issue: BeadIssue) => void;
  onDeleted: (issueId: string) => void;
  issueById: Map<string, BeadIssue>;
  memories: Memory[];
  history: ReturnType<typeof useSpecialistHistory>;
  jobId: string | null;
  chainId: string | null;
  onOpenBead: (issue: BeadIssue) => void;
  onSelectActivity: () => void;
}): ReactNode {
  switch (tab) {
    case "overview":
      return <div className="bead-inspector-stack">{props.projectId ? <BeadMutationPanel projectId={props.projectId} issue={props.issue} onIssueChange={props.onIssueChange} onDeleted={props.onDeleted} /> : null}<IssueDossier id={`bead-side-drawer-${props.issue.id}`} issue={props.issue} detail={props.detail} loading={props.loading} projectId={props.projectId} issueById={props.issueById} /></div>;
    case "lineage":
      return <LineageTab issue={props.issue} detail={props.detail} issueById={props.issueById} onOpenBead={props.onOpenBead} />;
    case "activity":
      return <BeadActivityPane key={`${props.issue.id}:${props.chainId ?? ""}:${props.jobId ?? ""}`} beadId={props.issue.id} jobIdHint={props.jobId} chainIdHint={props.chainId} />;
    case "evidence":
      return <EvidenceTab history={props.history} onSelectActivity={props.onSelectActivity} />;
    case "github":
      return <EmptyTab title="No linked GitHub evidence" body="PR, commit, and issue references will appear here when the materialized evidence refs include this bead." />;
    case "memories":
      return <MemoriesTab memories={props.memories} />;
    case "followups":
      return <FollowupsTab issue={props.issue} detail={props.detail} issueById={props.issueById} onOpenBead={props.onOpenBead} />;
  }
}

function LineageTab({ issue, detail, issueById, onOpenBead }: { issue: BeadIssue; detail: BeadIssueDetail | null; issueById: Map<string, BeadIssue>; onOpenBead: (issue: BeadIssue) => void }) {
  const groups = [
    { title: "Dependencies", items: detail?.dependencies ?? issue.dependencies },
    { title: "Dependents", items: detail?.dependents ?? [] },
    { title: "Children", items: detail?.children ?? [] },
    { title: "Related", items: (detail?.related_ids ?? issue.related_ids ?? []).map((id) => relationFromIssue(id, issueById)) },
  ].filter((group) => group.items.length > 0);

  if (groups.length === 0) return <EmptyTab title="No lineage" body="This bead has no dependency, child, dependent, or related records in the current state." />;

  return (
    <div className="bead-inspector-stack">
      {groups.map((group) => (
        <section key={group.title} className="bead-inspector-section">
          <div className="bead-section-title">{group.title}</div>
          <div className="bead-inspector-link-list">
            {group.items.map((item) => <LineageButton key={`${group.title}:${item.id}:${item.dependency_type}`} dependency={item} issue={issueById.get(item.id) ?? null} onOpenBead={onOpenBead} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function FollowupsTab({ issue, detail, issueById, onOpenBead }: { issue: BeadIssue; detail: BeadIssueDetail | null; issueById: Map<string, BeadIssue>; onOpenBead: (issue: BeadIssue) => void }) {
  const items = [
    ...(detail?.children ?? []),
    ...(detail?.dependents ?? []).filter((dep) => dep.dependency_type === "discovered-from" || dep.dependency_type === "tracks" || dep.dependency_type === "validates"),
  ];
  if (items.length === 0) return <EmptyTab title="No followups" body="No child, discovered-from, tracks, or validates followup beads are linked yet." />;
  return (
    <div className="bead-inspector-link-list">
      {items.map((item) => <LineageButton key={`followup:${issue.id}:${item.id}:${item.dependency_type}`} dependency={item} issue={issueById.get(item.id) ?? null} onOpenBead={onOpenBead} />)}
    </div>
  );
}

function LineageButton({ dependency, issue, onOpenBead }: { dependency: BeadDependency; issue: BeadIssue | null; onOpenBead: (issue: BeadIssue) => void }) {
  const target = issue ?? issueFromDependency(dependency);
  return (
    <button type="button" className="bead-inspector-link bead-inspector-issue-chip" onClick={() => onOpenBead(target)}>
      <span className="bead-inspector-issue-identity">
        <span className="bead-inspector-link-id">{dependency.id}</span>
        <span className="identity-separator">/</span>
        <span className="bead-inspector-link-title">{target.title}</span>
      </span>
      <span className="bead-inspector-link-meta">
        <span>P{target.priority}</span>
        <span>{String(target.issue_type)}</span>
        <span>{target.status}</span>
        <span>{dependency.dependency_type}</span>
      </span>
    </button>
  );
}

function EvidenceTab({ history, onSelectActivity }: { history: ReturnType<typeof useSpecialistHistory>; onSelectActivity: () => void }) {
  if (history.loading) return <EmptyTab title="Loading evidence" body="Specialist history is loading." />;
  if (history.jobs.length === 0) return <EmptyTab title="No specialist evidence" body="Terminal feeds, run results, forensic events, and evidence refs will collect here as jobs land." />;
  return (
    <div className="bead-inspector-stack">
      {history.jobs.map((job) => {
        const verdict = verdictForStatus(job.status);
        return (
          <article key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} className="bead-inspector-evidence-row">
            <div className="bead-inspector-evidence-head">
              <span className="bead-inspector-evidence-kind">{job.chainKind ?? "run"} proof</span>
              <span className={`bead-inspector-evidence-verdict ${statusToken(verdict)}`}>{verdict}</span>
            </div>
            <span className="bead-inspector-link-id">{job.jobId ?? job.beadId}</span>
            <span className="bead-inspector-link-title">{job.specialist ?? job.chainKind ?? "specialist"}</span>
            <div className="bead-inspector-evidence-meta">
              <span>{job.status}</span>
              <span>{formatElapsed(job.updatedAt)}</span>
              {job.chainId ? <span>{job.chainId}</span> : null}
            </div>
            <p>{job.lastOutput ? truncate(job.lastOutput, 220) : "No result output captured yet; open Activity for the chronological run context."}</p>
            <button type="button" className="bead-inspector-evidence-action" onClick={onSelectActivity}>View activity</button>
          </article>
        );
      })}
    </div>
  );
}

function MemoriesTab({ memories }: { memories: Memory[] }) {
  if (memories.length === 0) return <EmptyTab title="No memories" body="No project memory currently references this bead." />;
  return (
    <div className="bead-inspector-stack">
      {memories.map((memory) => (
        <article key={memory.id} className="bead-inspector-memory">
          <span className="bead-inspector-link-meta">{memory.type} / {formatCompactDate(memory.created_at)}</span>
          <p>{memory.content}</p>
          {memory.tags.length > 0 ? <div className="bead-label-strip">{memory.tags.map((tag) => <span key={tag} className="bead-label-chip">{tag}</span>)}</div> : null}
        </article>
      ))}
    </div>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return <div className="bead-inspector-empty"><b>{title}</b><span>{body}</span></div>;
}

function withCounts(items: typeof TABS, counts: Partial<Record<BeadInspectorTab, number>>) {
  return items.map((item) => ({ ...item, count: counts[item.id] ?? 0 }));
}

function countLineage(issue: BeadIssue, detail: BeadIssueDetail | null): number {
  return (detail?.dependencies ?? issue.dependencies).length + (detail?.dependents ?? []).length + (detail?.children ?? []).length + (detail?.related_ids ?? issue.related_ids ?? []).length;
}

function countFollowups(_issue: BeadIssue, detail: BeadIssueDetail | null): number {
  return (detail?.children ?? []).length + (detail?.dependents ?? []).filter((dep) => dep.dependency_type === "discovered-from" || dep.dependency_type === "tracks" || dep.dependency_type === "validates").length;
}

function relationFromIssue(id: string, issueById: Map<string, BeadIssue>): BeadDependency {
  const issue = issueById.get(id);
  return {
    id,
    title: issue?.title ?? id,
    status: issue?.status ?? "open",
    issue_type: issue?.issue_type,
    dependency_type: "related",
  };
}

function issueFromDependency(dependency: BeadDependency): BeadIssue {
  return {
    id: dependency.id,
    title: dependency.title || dependency.id,
    description: null,
    status: dependency.status,
    priority: 3,
    issue_type: dependency.issue_type ?? "task",
    owner: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dependencies: [],
    project_id: "",
    created_by: null,
    related_ids: [],
    labels: [],
  };
}

function formatCompactDate(iso: string | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function verdictForStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "done" || normalized === "success" || normalized === "completed") return "passed";
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") return "failed";
  if (normalized === "running" || normalized === "in_progress" || normalized === "queued") return "running";
  return "observed";
}

function statusToken(value: string): string {
  return `verdict-${value.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
