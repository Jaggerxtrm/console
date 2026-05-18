import { create } from "zustand";
import type { BeadDependency, BeadIssue, BeadsProject, Memory, AgentSession, ProjectSourceHealth } from "../../types/beads.ts";

export interface BeadsState {
  projects: BeadsProject[];
  selectedProjectId: string | null;
  issues: BeadIssue[];
  closedIssues: BeadIssue[];
  selectedIssue: BeadIssue | null;
  memories: Memory[];
  deps: BeadDependency[];
  kvs: Array<{ key: string; value: unknown; project_id: string }>;
  agentSessions: AgentSession[];
  sourceHealthByProject: Record<string, ProjectSourceHealth[]>;
  loading: boolean;
  error: string | null;
  setProjects: (projects: BeadsProject[]) => void;
  selectProject: (id: string | null) => void;
  setIssues: (issues: BeadIssue[]) => void;
  setClosedIssues: (issues: BeadIssue[]) => void;
  upsertIssue: (issue: BeadIssue) => void;
  moveToClosed: (issueId: string) => void;
  removeIssue: (issueId: string) => void;
  applyBatch: (changes: { upserts?: BeadIssue[]; closes?: string[]; deletes?: string[]; dependencies?: BeadDependency[]; memories?: Memory[]; kv?: Array<{ key: string; value: unknown; project_id: string }> }) => void;
  applySyncHint: (projectId: string, scope?: string) => void;
  upsertDep: (dep: BeadDependency) => void;
  removeDep: (depId: string) => void;
  upsertMemory: (memory: Memory) => void;
  removeMemory: (memoryId: string) => void;
  upsertKv: (kv: { key: string; value: unknown; project_id: string }) => void;
  removeKv: (key: string) => void;
  selectIssue: (issue: BeadIssue | null) => void;
  setMemories: (memories: Memory[]) => void;
  setAgentSessions: (sessions: AgentSession[]) => void;
  setSourceHealth: (projectId: string, health: ProjectSourceHealth[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const next = items.filter((current) => current.id !== item.id);
  next.unshift(item);
  return next;
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

function closeIssue(issue: BeadIssue): BeadIssue {
  return { ...issue, status: "closed", closed_at: issue.closed_at ?? issue.updated_at };
}

export const useBeadsStore = create<BeadsState>((set) => ({
  projects: [],
  selectedProjectId: null,
  issues: [],
  closedIssues: [],
  selectedIssue: null,
  memories: [],
  deps: [],
  kvs: [],
  agentSessions: [],
  sourceHealthByProject: {},
  loading: false,
  error: null,

  setProjects: (projects) => set({ projects }),
  selectProject: (id) => set({ selectedProjectId: id }),
  setIssues: (issues) => set({ issues }),
  setClosedIssues: (closedIssues) => set({ closedIssues }),
  upsertIssue: (issue) => set((state) => {
    const nextIssues = issue.status === "closed" ? state.issues.filter((item) => item.id !== issue.id) : upsertById(state.issues, issue);
    const nextClosedIssues = issue.status === "closed" ? upsertById(state.closedIssues, issue) : state.closedIssues.filter((item) => item.id !== issue.id);
    return { issues: nextIssues, closedIssues: nextClosedIssues };
  }),
  moveToClosed: (issueId) => set((state) => {
    const issue = state.issues.find((item) => item.id === issueId) ?? state.closedIssues.find((item) => item.id === issueId);
    if (!issue) return state;
    const closedIssue = closeIssue(issue);
    return { issues: removeById(state.issues, issueId), closedIssues: upsertById(state.closedIssues, closedIssue) };
  }),
  removeIssue: (issueId) => set((state) => ({ issues: removeById(state.issues, issueId), closedIssues: removeById(state.closedIssues, issueId) })),
  applyBatch: (changes) => set((state) => {
    let nextIssues = [...state.issues];
    let nextClosedIssues = [...state.closedIssues];
    let nextDeps = [...state.deps];
    let nextMemories = [...state.memories];
    let nextKvs = [...state.kvs];

    for (const issue of changes.upserts ?? []) {
      nextIssues = removeById(nextIssues, issue.id);
      nextClosedIssues = removeById(nextClosedIssues, issue.id);
      if (issue.status === "closed") nextClosedIssues = upsertById(nextClosedIssues, issue);
      else nextIssues = upsertById(nextIssues, issue);
    }
    for (const issueId of changes.closes ?? []) {
      const issue = nextIssues.find((item) => item.id === issueId) ?? nextClosedIssues.find((item) => item.id === issueId);
      if (issue) {
        nextIssues = removeById(nextIssues, issueId);
        nextClosedIssues = upsertById(nextClosedIssues, closeIssue(issue));
      }
    }
    for (const issueId of changes.deletes ?? []) {
      nextIssues = removeById(nextIssues, issueId);
      nextClosedIssues = removeById(nextClosedIssues, issueId);
    }
    for (const dep of changes.dependencies ?? []) nextDeps = upsertById(nextDeps, dep);
    for (const memory of changes.memories ?? []) nextMemories = upsertById(nextMemories, memory);
    for (const kv of changes.kv ?? []) {
      nextKvs = nextKvs.filter((item) => item.key !== kv.key);
      nextKvs.unshift(kv);
    }

    return { issues: nextIssues, closedIssues: nextClosedIssues, deps: nextDeps, memories: nextMemories, kvs: nextKvs };
  }),
  applySyncHint: (projectId) => set((state) => {
    const sourceHealth = state.sourceHealthByProject[projectId] ?? [];
    return { sourceHealthByProject: { ...state.sourceHealthByProject, [projectId]: sourceHealth } };
  }),
  upsertDep: (dep) => set((state) => ({ deps: upsertById(state.deps, dep) })),
  removeDep: (depId) => set((state) => ({ deps: state.deps.filter((item) => item.id !== depId) })),
  upsertMemory: (memory) => set((state) => ({ memories: upsertById(state.memories, memory) })),
  removeMemory: (memoryId) => set((state) => ({ memories: state.memories.filter((item) => item.id !== memoryId) })),
  upsertKv: (kv) => set((state) => ({ kvs: [kv, ...state.kvs.filter((item) => item.key !== kv.key)] })),
  removeKv: (key) => set((state) => ({ kvs: state.kvs.filter((item) => item.key !== key) })),
  selectIssue: (issue) => set({ selectedIssue: issue }),
  setMemories: (memories) => set({ memories }),
  setAgentSessions: (agentSessions) => set({ agentSessions }),
  setSourceHealth: (projectId, health) => set((state) => ({ sourceHealthByProject: { ...state.sourceHealthByProject, [projectId]: health } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
