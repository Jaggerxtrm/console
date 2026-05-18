import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FilterIcon, InboxIcon, ProjectIcon, ArchiveIcon, DatabaseIcon, CheckIcon, SearchIcon } from "@primer/octicons-react";
import { IssueFeed, IssueRow, countDependencies } from "./components/beads/IssueFeed.tsx";
import { KanbanBoard } from "./components/beads/KanbanBoard.tsx";
import { ProjectRail, type ProjectRailStats } from "./components/beads/ProjectRail.tsx";
import { useBeadsStore } from "./stores/beads.ts";
import { useBeadsLive } from "./hooks/useBeadsLive.ts";
import { api, type OpenPr } from "./lib/api.ts";
import type { BeadIssue, BeadIssueDetail, Memory, Interaction } from "../types/beads.ts";

type Tab = "issues" | "board" | "closed" | "memories" | "triage";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "issues", label: "Feed" },
  { id: "board", label: "Board" },
  { id: "triage", label: "Triage" },
  { id: "closed", label: "Closed" },
  { id: "memories", label: "Memories" },
];

const STALE_DAYS = 7;
const VELOCITY_WINDOWS_DAYS = [7, 30] as const;
const PRIORITY_WEIGHT: Record<number, number> = { 0: 1, 1: 0.75, 2: 0.5, 3: 0.25, 4: 0 };

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("issues");
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssueDetail, setSelectedIssueDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [openPrs, setOpenPrs] = useState<OpenPr[]>([]);
  const [statsByProject, setStatsByProject] = useState<Record<string, ProjectRailStats | undefined>>({});
  const [loadingProjectStats, setLoadingProjectStats] = useState(false);
  const [showOpenOnly, setShowOpenOnly] = useState(false);
  const [issueSearch, setIssueSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<"all" | "ready" | "blocked" | "stale">("all");
  const requestIdRef = useRef(0);

  const {
    projects,
    selectedProjectId,
    issues,
    closedIssues,
    memories,
    loading,
    error,
    setProjects,
    selectProject,
    setIssues,
    setClosedIssues,
    setMemories,
    setLoading,
    setError,
    sourceHealthByProject,
  } = useBeadsStore();

  useBeadsLive();

  useEffect(() => {
    async function loadProjects() {
      setLoading(true);
      try {
        const projs = await api.getProjects();
        setProjects(projs);
        if (projs.length > 0 && !selectedProjectId) {
          selectProject(projs[0].id);
        }
      } catch (err) {
        setError("Failed to load projects");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadProjects();
  }, []);

  useEffect(() => {
    let alive = true;
    api.getOpenPrs().then((prs) => { if (alive) setOpenPrs(prs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const loadProjectData = useCallback(async (projectId: string) => {
    setLoading(true);
    setSelectedIssueId(null);
    setSelectedIssueDetail(null);
    try {
      const [issueData, closedData, memoryData, interactionData] = await Promise.all([
        api.getIssues(projectId),
        api.getClosedIssues(projectId, 50),
        api.getMemories(projectId),
        api.getInteractions(projectId),
      ]);
      setIssues(issueData);
      setClosedIssues(closedData);
      setMemories(memoryData);
      setInteractions(interactionData);
    } catch (err) {
      setError("Failed to load project data");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [setIssues, setClosedIssues, setMemories, setLoading, setError]);

  useEffect(() => {
    if (selectedProjectId) loadProjectData(selectedProjectId);
  }, [selectedProjectId, loadProjectData]);

  useEffect(() => {
    if (projects.length === 0) {
      setStatsByProject({});
      return;
    }

    let cancelled = false;
    async function loadProjectStats() {
      setLoadingProjectStats(true);
      const entries = await Promise.all(projects.map(async (project) => {
        try {
          const stats = await api.getStats(project.id);
          return [project.id, stats] as const;
        } catch (err) {
          console.error(`Failed to load stats for ${project.id}`, err);
          return [project.id, undefined] as const;
        }
      }));

      if (!cancelled) {
        setStatsByProject(Object.fromEntries(entries));
        setLoadingProjectStats(false);
      }
    }

    loadProjectStats();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const handleIssueSelect = useCallback(async (issue: BeadIssue) => {
    if (!selectedProjectId) return;
    if (loadingDetailId === issue.id) return;
    if (selectedIssueId === issue.id) {
      setSelectedIssueId(null);
      setSelectedIssueDetail(null);
      return;
    }

    setSelectedIssueId(issue.id);
    setSelectedIssueDetail(null);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoadingDetailId(issue.id);
    try {
      const detail = await api.getIssue(selectedProjectId, issue.id);
      if (requestIdRef.current !== requestId) return;
      setSelectedIssueDetail(detail ?? null);
    } catch (err) {
      if (requestIdRef.current === requestId) {
        console.error(err);
        setSelectedIssueDetail(null);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoadingDetailId(null);
      }
    }
  }, [loadingDetailId, selectedIssueId, selectedProjectId]);

  const getAgentForIssue = useCallback((issueId: string): string | null => {
    const issueInteractions = interactions.filter((i) => i.issue_id === issueId);
    if (issueInteractions.length === 0) return null;
    const model = issueInteractions[0]?.model;
    if (!model) return null;
    const lower = model.toLowerCase();
    if (lower.includes("claude")) return "claude";
    if (lower.includes("qwen")) return "qwen";
    if (lower.includes("gemini")) return "gemini";
    if (lower.includes("gpt")) return "gpt";
    return null;
  }, [interactions]);

  const filteredIssues = useMemo(() => filterIssues(issues, { openOnly: showOpenOnly, search: issueSearch, quickFilter }), [issues, showOpenOnly, issueSearch, quickFilter]);
  const filteredClosedIssues = useMemo(() => filterIssues(closedIssues, { openOnly: showOpenOnly, search: issueSearch, quickFilter }), [closedIssues, showOpenOnly, issueSearch, quickFilter]);
  const triage = useMemo(() => buildTriageView(issues, closedIssues), [closedIssues, issues]);
  const prByIssueId = useMemo(() => {
    const map = new Map<string, OpenPr>();
    if (openPrs.length === 0 || issues.length === 0) return map;
    for (const pr of openPrs) {
      const text = `${pr.title} ${pr.body ?? ""}`;
      for (const issue of issues) {
        if (!issue.id) continue;
        // Match id as a whole token; allow id with dots (epic children)
        const re = new RegExp(`(?:^|[^a-zA-Z0-9-])${issue.id.replace(/[.]/g, "\\.")}(?![a-zA-Z0-9-])`);
        if (re.test(text)) {
          const existing = map.get(issue.id);
          if (!existing || (pr.updated_at ?? "") > (existing.updated_at ?? "")) {
            map.set(issue.id, pr);
          }
        }
      }
    }
    return map;
  }, [openPrs, issues]);
  const segmentCounts = useMemo(() => ({ issues: filteredIssues.length, board: filteredIssues.length, triage: triage.topPicks.length, closed: filteredClosedIssues.length, memories: memories.length }), [filteredClosedIssues.length, filteredIssues.length, memories.length, triage.topPicks.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-primary)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
      <div className="module-header-shell">
      <header className="module-header">
        <div className="module-segments">
          {TABS.map((tab) => {
            const Icon = tab.id === "issues" ? InboxIcon : tab.id === "board" ? ProjectIcon : tab.id === "closed" ? ArchiveIcon : DatabaseIcon;
            return (
              <button
                key={tab.id}
                type="button"
                className={`module-segment ${activeTab === tab.id ? "is-active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={12} />
                <span>{tab.label}</span>
                <span className="module-count">{segmentCounts[tab.id]}</span>
              </button>
            );
          })}
        </div>
        <div className="module-actions">
          <label className="module-search" htmlFor="issue-search">
            <SearchIcon size={12} />
            <input id="issue-search" type="search" value={issueSearch} onChange={(event) => setIssueSearch(event.target.value)} placeholder="Search issues" />
          </label>
          <button type="button" className={`module-icon-btn ${showOpenOnly ? "is-active" : ""}`} onClick={() => setShowOpenOnly((value) => !value)} aria-pressed={showOpenOnly}>
            <FilterIcon size={12} /> Filter
          </button>
        </div>
        <div className="module-quick-filters" role="group" aria-label="Quick issue filters">
          {(["all", "ready", "blocked", "stale"] as const).map((filter) => (
            <button key={filter} type="button" className={`module-chip ${quickFilter === filter ? "is-active" : ""}`} onClick={() => setQuickFilter(filter)} aria-pressed={quickFilter === filter}>
              {filter}
            </button>
          ))}
        </div>
        {loading && <span className="module-status">Loading...</span>}
        {selectedProjectId && sourceHealthByProject[selectedProjectId] && (
          <span className="module-status">{renderSourceHealth(sourceHealthByProject[selectedProjectId])}</span>
        )}
        {error && <span className="module-status is-error">{error}</span>}
      </header>
      </div>

      <main style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <ProjectRail
          projects={projects}
          selectedProjectId={selectedProjectId}
          statsByProject={statsByProject}
          loadingStats={loadingProjectStats}
          onSelectProject={selectProject}
        />

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {activeTab === "issues" && (
            <IssueFeed
              issues={filteredIssues}
              selectedIssueId={selectedIssueId}
              selectedIssueDetail={selectedIssueDetail}
              loadingDetailId={loadingDetailId}
              onIssueSelect={handleIssueSelect}
              getAgent={getAgentForIssue}
              projectId={selectedProjectId}
              prByIssueId={prByIssueId}
            />
          )}
          {activeTab === "board" && <KanbanBoard issues={filteredIssues} projectId={selectedProjectId} interactions={interactions} getAgent={getAgentForIssue} prByIssueId={prByIssueId} />}
          {activeTab === "triage" && (
            <TriagePanel
              triage={triage}
              prByIssueId={prByIssueId}
              issues={issues}
              selectedIssueId={selectedIssueId}
              selectedIssueDetail={selectedIssueDetail}
              loadingDetailId={loadingDetailId}
              onIssueSelect={handleIssueSelect}
              getAgent={getAgentForIssue}
              projectId={selectedProjectId}
            />
          )}
          {activeTab === "closed" && <ClosedIssuesPanel issues={filteredClosedIssues} getAgent={getAgentForIssue} />}
          {activeTab === "memories" && <MemoriesPanel memories={memories} />}
        </div>
      </main>
    </div>
  );
}

function ClosedIssuesPanel({ issues, getAgent }: { issues: BeadIssue[]; getAgent: (id: string) => string | null; }) {
  return <div style={{ padding: 12, color: 'var(--text-secondary)' }}><h2 style={{ marginBottom: 12, color: 'var(--text-primary)' }}>Closed Issues</h2>{issues.length === 0 ? <p>No closed issues</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{issues.map(issue => <div key={issue.id} style={{ padding: 'var(--spacing-sm)', background: 'var(--surface-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}><span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{issue.id}</span>{getAgent(issue.id) && <AgentBadge agent={getAgent(issue.id)!} />}</div><div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{issue.title}</div>{issue.close_reason && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}><CheckIcon size={12} />{issue.close_reason}</div>}</div>)}</div>}</div>;
}

function MemoriesPanel({ memories }: { memories: Memory[] }) {
  return <div style={{ padding: 12, color: 'var(--text-secondary)' }}><h2 style={{ marginBottom: 12, color: 'var(--text-primary)' }}>Memories</h2>{memories.length === 0 ? <p>No memories stored. Use <code style={{ background: 'var(--surface-tertiary)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>bd remember "insight"</code> to add one.</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{memories.map(memory => <div key={memory.id} style={{ padding: 'var(--spacing-sm)', background: 'var(--surface-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}><div style={{ display: 'flex', gap: 6, marginBottom: 2 }}><span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: 'var(--surface-tertiary)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)' }}>{memory.type}</span>{memory.tags.map(tag => <span key={tag} style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-blue)' }}>#{tag}</span>)}</div><div style={{ color: 'var(--text-primary)' }}>{memory.content}</div>{memory.issue_id && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>Issue: {memory.issue_id}</div>}</div>)}</div>}</div>;
}

function AgentBadge({ agent }: { agent: string }) {
  return <span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: 'var(--surface-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{agent}</span>;
}

function renderSourceHealth(health: { kind: string; state: string; detail?: string }[]) {
  const primary = health.find((item) => item.state === "available") ?? health[0];
  if (!primary) return "source: unknown";
  const drift = health.some((item) => item.detail?.startsWith("drift"));
  const label = primary.kind === "dolt" ? "Dolt ✓" : primary.kind === "jsonl" ? "JSONL fallback" : primary.kind;
  return drift ? `${label} drift` : label;
}

function filterIssues(issues: BeadIssue[], { openOnly, search, quickFilter }: { openOnly: boolean; search: string; quickFilter: "all" | "ready" | "blocked" | "stale"; }) {
  const query = search.trim().toLowerCase();
  return issues.filter((issue) => {
    if (openOnly && issue.status === "closed") return false;
    if (quickFilter !== "all" && !matchesQuickFilter(issue, quickFilter)) return false;
    if (!query) return true;
    return [issue.id, issue.title, issue.description ?? ""].some((value) => value.toLowerCase().includes(query));
  });
}

function matchesQuickFilter(issue: BeadIssue, quickFilter: "all" | "ready" | "blocked" | "stale") {
  switch (quickFilter) {
    case "ready": return issue.status === "open" || issue.status === "in_progress";
    case "blocked": return issue.status === "blocked";
    case "stale": return isStaleIssue(issue);
    default: return true;
  }
}

function isStaleIssue(issue: BeadIssue) {
  if (issue.status === "closed") return false;
  const updatedAt = new Date(issue.updated_at);
  if (Number.isNaN(updatedAt.getTime())) return false;
  const staleThresholdMs = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - updatedAt.getTime() >= staleThresholdMs;
}

// ── Triage ────────────────────────────────────────────────────────────────────

type TriageIssue = BeadIssue & { score: number; daysIdle: number; blockerCount: number };

type TriageView = {
  topPicks: TriageIssue[];
  quickWins: TriageIssue[];
  staleIssues: TriageIssue[];
  velocity: { last7: number; last30: number };
  health: {
    countsByStatus: Record<string, number>;
    countsByType: Record<string, number>;
    countsByPriority: Record<string, number>;
  };
};

function buildTriageView(issues: BeadIssue[], closedIssues: BeadIssue[]): TriageView {
  const openIssues = issues.filter((issue) => issue.status !== "closed");
  const scored: TriageIssue[] = openIssues.map((issue) => ({ ...issue, ...getTriageSignals(issue, openIssues) }));
  const topPicks = [...scored].sort((a, b) => b.score - a.score).slice(0, 5);
  const quickWins = scored.filter((i) => i.priority >= 2 && i.blockerCount === 0).sort((a, b) => a.priority - b.priority || b.score - a.score).slice(0, 5);
  const staleIssues = scored.filter((i) => i.daysIdle >= STALE_DAYS).sort((a, b) => b.daysIdle - a.daysIdle || b.score - a.score).slice(0, 5);
  return {
    topPicks,
    quickWins,
    staleIssues,
    velocity: getVelocity(closedIssues),
    health: getHealthCounts(issues, closedIssues),
  };
}

function getTriageSignals(issue: BeadIssue, openIssues: BeadIssue[]) {
  const daysIdle = getDaysSince(issue.updated_at ?? issue.created_at);
  const blockerCount = issue.dependencies.filter((d) => d.dependency_type === "blocks" || d.dependency_type === "blocked_by").length;
  const priorityWeight = PRIORITY_WEIGHT[issue.priority as number] ?? 0;
  const stalenessWeight = Math.min(daysIdle / 30, 1);
  const openLoadWeight = Math.min(openIssues.length / 100, 1);
  return { daysIdle, blockerCount, score: priorityWeight + stalenessWeight + openLoadWeight };
}

function getDaysSince(isoDate: string): number {
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function getVelocity(closedIssues: BeadIssue[]) {
  const now = Date.now();
  const closedAt = (i: BeadIssue) => new Date(i.closed_at ?? i.updated_at).getTime();
  return {
    last7: closedIssues.filter((i) => now - closedAt(i) <= VELOCITY_WINDOWS_DAYS[0] * 86_400_000).length,
    last30: closedIssues.filter((i) => now - closedAt(i) <= VELOCITY_WINDOWS_DAYS[1] * 86_400_000).length,
  };
}

function getHealthCounts(issues: BeadIssue[], closedIssues: BeadIssue[]) {
  const all = [...issues, ...closedIssues];
  const countsByStatus: Record<string, number> = {};
  const countsByType: Record<string, number> = {};
  const countsByPriority: Record<string, number> = {};
  for (const i of all) {
    countsByStatus[i.status] = (countsByStatus[i.status] ?? 0) + 1;
    countsByType[i.issue_type] = (countsByType[i.issue_type] ?? 0) + 1;
    const p = `P${i.priority}`;
    countsByPriority[p] = (countsByPriority[p] ?? 0) + 1;
  }
  return { countsByStatus, countsByType, countsByPriority };
}

interface TriagePanelProps {
  triage: TriageView;
  issues: BeadIssue[];
  selectedIssueId: string | null;
  selectedIssueDetail: BeadIssueDetail | null;
  loadingDetailId: string | null;
  onIssueSelect: (issue: BeadIssue) => void;
  getAgent: (id: string) => string | null;
  projectId: string | null;
  prByIssueId?: Map<string, OpenPr>;
}

function TriagePanel({ triage, issues, selectedIssueId, selectedIssueDetail, loadingDetailId, onIssueSelect, getAgent, projectId, prByIssueId }: TriagePanelProps) {
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);

  const renderRow = (issue: TriageIssue) => {
    const full = issueById.get(issue.id);
    if (!full) return null;
    return (
      <IssueRow
        key={issue.id}
        issue={full}
        detail={selectedIssueId === issue.id ? selectedIssueDetail : null}
        isExpanded={selectedIssueId === issue.id}
        isLoadingDetail={loadingDetailId === issue.id}
        agent={getAgent(issue.id)}
        dependencyCount={countDependencies(full)}
        childCount={0}
        onClick={() => onIssueSelect(full)}
        projectId={projectId}
        issueById={issueById}
        prLink={prByIssueId?.get(issue.id) ?? null}
      />
    );
  };

  return (
    <div style={{ padding: 12, display: 'grid', gap: 12, overflowY: 'auto' }}>
      <section style={triagePanelStyle}>
        <h2 style={triageSectionTitleStyle}>Top picks</h2>
        {triage.topPicks.length === 0
          ? <div style={triageEmptyStyle}>No open issues</div>
          : <div style={{ display: 'grid', gap: 4 }}>{triage.topPicks.map(renderRow)}</div>}
      </section>
      <section style={triagePanelStyle}>
        <h2 style={triageSectionTitleStyle}>Quick wins</h2>
        {triage.quickWins.length === 0
          ? <div style={triageEmptyStyle}>No quick wins</div>
          : <div style={{ display: 'grid', gap: 4 }}>{triage.quickWins.map(renderRow)}</div>}
      </section>
      <section style={triagePanelStyle}>
        <h2 style={triageSectionTitleStyle}>Stale ({STALE_DAYS}d+)</h2>
        {triage.staleIssues.length === 0
          ? <div style={triageEmptyStyle}>No stale issues</div>
          : <div style={{ display: 'grid', gap: 4 }}>{triage.staleIssues.map(renderRow)}</div>}
      </section>
      <section style={triagePanelStyle}>
        <h2 style={triageSectionTitleStyle}>Velocity</h2>
        <div style={triageStatsGridStyle}>
          <TriageStatCard label="Last 7 days" value={String(triage.velocity.last7)} />
          <TriageStatCard label="Last 30 days" value={String(triage.velocity.last30)} />
        </div>
      </section>
      <section style={triagePanelStyle}>
        <h2 style={triageSectionTitleStyle}>Project health</h2>
        <TriageStatGrid title="By status" items={triage.health.countsByStatus} />
        <TriageStatGrid title="By type" items={triage.health.countsByType} />
        <TriageStatGrid title="By priority" items={triage.health.countsByPriority} />
      </section>
    </div>
  );
}

function TriageStatGrid({ title, items }: { title: string; items: Record<string, number> }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={triageStatGroupTitleStyle}>{title}</div>
      <div style={triageStatsGridStyle}>
        {Object.entries(items).map(([label, value]) => <TriageStatCard key={label} label={label} value={String(value)} />)}
      </div>
    </div>
  );
}

function TriageStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={triageStatCardStyle}>
      <div style={triageIssueMetaStyle}>{label}</div>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 'var(--text-base)' }}>{value}</div>
    </div>
  );
}

const triagePanelStyle = { background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', padding: 10 } as const;
const triageSectionTitleStyle = { marginBottom: 8, color: 'var(--text-primary)', fontSize: 'var(--text-sm)', fontWeight: 600 } as const;
const triageStatGroupTitleStyle = { marginBottom: 4, color: 'var(--text-muted)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' } as const;
const triageStatsGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 } as const;
const triageStatCardStyle = { background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', padding: 8 } as const;
const triageEmptyStyle = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' } as const;
const triageIssueCardStyle = { background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', padding: 8 } as const;
const triageIssueRowStyle = { display: 'flex', justifyContent: 'space-between', gap: 8 } as const;
const triageIssueIdStyle = { fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' } as const;
const triageIssueScoreStyle = { color: 'var(--accent)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' } as const;
const triageIssueTitleStyle = { color: 'var(--text-primary)', fontWeight: 500, marginTop: 2, fontSize: 'var(--text-sm)' } as const;
const triageIssueMetaStyle = { color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 } as const;
