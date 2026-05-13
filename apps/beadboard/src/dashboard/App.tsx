import { useState, useEffect, useCallback, useRef } from "react";
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
          const requestedProject = new URLSearchParams(window.location.search).get("project");
          const matchedProject = requestedProject
            ? projs.find((project) => project.id === requestedProject || project.name === requestedProject)
            : null;
          selectProject((matchedProject ?? projs[0]).id);
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

  const getAgentForIssue = (issueId: string): string | null => {
    const issueInteractions = interactions.filter(i => i.issue_id === issueId);
    if (issueInteractions.length === 0) return null;
    const model = issueInteractions[0]?.model;
    if (!model) return null;
    const lower = model.toLowerCase();
    if (lower.includes("claude")) return "claude";
    if (lower.includes("qwen")) return "qwen";
    if (lower.includes("gemini")) return "gemini";
    if (lower.includes("gpt")) return "gpt";
    return null;
  };

  return (
    <div className="xtrm-shell">
      <header className="xtrm-topbar">
        <span className="xtrm-brand">Beadboard</span>
        <nav style={{ display: 'flex', gap: 4, height: '100%', alignItems: 'stretch' }}>
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ padding: '0 10px', fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', background: 'transparent', border: 'none', borderBottom: activeTab === tab.id ? '1px solid rgba(142,210,220,0.72)' : '1px solid transparent', cursor: 'pointer' }}>{tab.label}</button>
          ))}
        </nav>
        {loading && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading...</span>}
        {error && <span style={{ marginLeft: 'auto', color: 'var(--status-blocked)', fontSize: 'var(--text-sm)' }}>{error}</span>}
      </header>

      <main className="xtrm-console-main">
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
              issues={issues}
              selectedIssueId={selectedIssueId}
              selectedIssueDetail={selectedIssueDetail}
              loadingDetailId={loadingDetailId}
              onIssueSelect={handleIssueSelect}
              getAgent={getAgentForIssue}
            />
          )}
          {activeTab === "board" && <KanbanBoard issues={issues} getAgent={getAgentForIssue} onIssueClick={() => setActiveTab("issues")} />}
          {activeTab === "closed" && <ClosedIssuesPanel issues={closedIssues} getAgent={getAgentForIssue} />}
          {activeTab === "memories" && <MemoriesPanel memories={memories} />}
        </div>
      </main>
    </div>
  );
}

function ClosedIssuesPanel({ issues, getAgent }: { issues: BeadIssue[]; getAgent: (id: string) => string | null; }) {
  return <div style={{ padding: 16, color: 'var(--text-secondary)' }}><h2 style={{ marginBottom: 16, color: 'var(--text-primary)' }}>Closed Issues</h2>{issues.length === 0 ? <p>No closed issues</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{issues.map(issue => <div key={issue.id} style={{ padding: 'var(--spacing-md)', background: 'var(--surface-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}><span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{issue.id}</span>{getAgent(issue.id) && <AgentBadge agent={getAgent(issue.id)!} />}</div><div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{issue.title}</div>{issue.close_reason && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>✓ {issue.close_reason}</div>}</div>)}</div>}</div>;
}

function MemoriesPanel({ memories }: { memories: Memory[] }) {
  return <div style={{ padding: 16, color: 'var(--text-secondary)' }}><h2 style={{ marginBottom: 16, color: 'var(--text-primary)' }}>Memories</h2>{memories.length === 0 ? <p>No memories stored. Use <code style={{ background: 'var(--surface-tertiary)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>bd remember "insight"</code> to add one.</p> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{memories.map(memory => <div key={memory.id} style={{ padding: 'var(--spacing-md)', background: 'var(--surface-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}><div style={{ display: 'flex', gap: 8, marginBottom: 4 }}><span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: 'var(--surface-tertiary)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)' }}>{memory.type}</span>{memory.tags.map(tag => <span key={tag} style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-blue)' }}>#{tag}</span>)}</div><div style={{ color: 'var(--text-primary)' }}>{memory.content}</div>{memory.issue_id && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>Issue: {memory.issue_id}</div>}</div>)}</div>}</div>;
}

function AgentBadge({ agent }: { agent: string }) {
  const colors: Record<string, string> = { claude: '#D97706', qwen: '#10B981', gemini: '#3B82F6', gpt: '#6366F1' };
  return <span style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: colors[agent] || 'var(--surface-tertiary)', color: 'white', borderRadius: 'var(--radius-pill)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{agent}</span>;
}
