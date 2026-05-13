import { useState, useEffect, useCallback } from "react";
import { IssueFeed } from "./components/beads/IssueFeed.tsx";
import { useBeadsStore } from "./stores/beads.ts";
import { api } from "./lib/api.ts";
import type { BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../types/beads.ts";

type Tab = "issues" | "closed" | "memories";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "closed", label: "Closed" },
  { id: "memories", label: "Memories" },
];

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("issues");
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedIssueDetail, setSelectedIssueDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

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

  const handleIssueSelect = useCallback(async (issue: BeadIssue) => {
    if (!selectedProjectId) return;
    if (loadingDetailId === issue.id) return;
    if (selectedIssueDetail?.id === issue.id) {
      setSelectedIssueDetail(null);
      return;
    }
    setLoadingDetailId(issue.id);
    try {
      const detail = await api.getIssue(selectedProjectId, issue.id);
      setSelectedIssueDetail(detail ?? null);
    } catch (err) {
      console.error(err);
      setSelectedIssueDetail(null);
    } finally {
      setLoadingDetailId(null);
    }
  }, [loadingDetailId, selectedIssueDetail?.id, selectedProjectId]);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-primary)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '0 20px', height: 'var(--topbar-height)', background: 'var(--surface-secondary)', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Beadboard</span>
        <nav style={{ display: 'flex', gap: 4, height: '100%', alignItems: 'stretch' }}>
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ padding: '0 12px', fontSize: 'var(--text-base)', fontWeight: 500, color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)', background: 'transparent', border: 'none', borderBottom: activeTab === tab.id ? '2px solid var(--accent-blue)' : '2px solid transparent', cursor: 'pointer' }}>{tab.label}</button>
          ))}
        </nav>
        {loading && <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading...</span>}
        {error && <span style={{ marginLeft: 'auto', color: 'var(--status-blocked)', fontSize: 'var(--text-sm)' }}>{error}</span>}
      </header>

      <main style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <aside style={{ width: 'var(--sidebar-width)', borderRight: '1px solid var(--border-subtle)', background: 'var(--surface-secondary)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>Projects</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {projects.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No projects found</div> : projects.map(project => (
                <button key={project.id} onClick={() => selectProject(project.id)} style={{ padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', background: selectedProjectId === project.id ? 'var(--surface-tertiary)' : 'transparent', color: 'var(--text-primary)', fontSize: 'var(--text-sm)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>{project.name}</button>
              ))}
            </div>
          </div>

          {selectedProjectId && (
            <div>
              <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>Stats</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <StatBadge label="Ready" count={issues.filter(i => i.status === 'open').length} color="var(--status-open)" />
                <StatBadge label="Progress" count={issues.filter(i => i.status === 'in_progress').length} color="var(--accent-blue)" />
                <StatBadge label="Blocked" count={issues.filter(i => i.status === 'blocked').length} color="var(--status-blocked)" />
                <StatBadge label="Closed" count={closedIssues.length} color="var(--status-closed)" />
              </div>
            </div>
          )}
        </aside>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {activeTab === "issues" && (
            <IssueFeed
              issues={issues}
              selectedIssueId={selectedIssueDetail?.id ?? null}
              selectedIssueDetail={selectedIssueDetail}
              loadingDetailId={loadingDetailId}
              onIssueSelect={handleIssueSelect}
              getAgent={getAgentForIssue}
            />
          )}
          {activeTab === "closed" && <ClosedIssuesPanel issues={closedIssues} getAgent={getAgentForIssue} />}
          {activeTab === "memories" && <MemoriesPanel memories={memories} />}
        </div>
      </main>
    </div>
  );
}

function StatBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 'var(--spacing-xs) var(--spacing-sm)', background: 'var(--surface-tertiary)', borderRadius: 'var(--radius-sm)' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} /><span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{label}</span><span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, marginLeft: 'auto' }}>{count}</span></div>;
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
