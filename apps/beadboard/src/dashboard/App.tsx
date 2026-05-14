import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { FilterIcon, InboxIcon, ProjectIcon, ArchiveIcon, DatabaseIcon, CheckIcon, SearchIcon } from "@primer/octicons-react";
import { IssueFeed } from "./components/beads/IssueFeed.tsx";
import { KanbanBoard } from "./components/beads/KanbanBoard.tsx";
import { ProjectRail, type ProjectRailStats } from "./components/beads/ProjectRail.tsx";
import { useBeadsStore } from "./stores/beads.ts";
import { api } from "./lib/api.ts";
import type { BeadIssue, BeadIssueDetail, Memory, Interaction } from "../types/beads.ts";

type Tab = "issues" | "board" | "closed" | "memories";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "issues", label: "Feed" },
  { id: "board", label: "Board" },
  { id: "closed", label: "Closed" },
  { id: "memories", label: "Memories" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("issues");
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedIssueDetail, setSelectedIssueDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
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
  } = useBeadsStore();

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
  const segmentCounts = useMemo(() => ({ feed: filteredIssues.length, board: filteredIssues.length, closed: filteredClosedIssues.length, memories: memories.length }), [filteredClosedIssues.length, filteredIssues.length, memories.length]);

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
            />
          )}
          {activeTab === "board" && <KanbanBoard issues={filteredIssues} projectId={selectedProjectId} interactions={interactions} getAgent={getAgentForIssue} />}
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
