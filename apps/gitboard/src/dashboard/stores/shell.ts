// Unified IDE-shell store (forge-5w9.3).
// Holds repo tree, expanded set, current selection, sidebar collapse.
// Persists expanded/selection/sidebarCollapsed to localStorage so reload restores
// navigation state (forge-5w9 UX note).

import { create } from "zustand";
import type { LeafId, RepoNode, RepoSection, SidebarSelection } from "../../types/shell.ts";

const LS = {
  expanded: "forge-5w9:expanded",
  selection: "forge-5w9:selection",
  collapsed: "forge-5w9:sidebarCollapsed",
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== "undefined" && localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

const initialExpanded = new Set<string>(readJSON<string[]>(LS.expanded, []));
const initialSelection = readJSON<SidebarSelection | null>(LS.selection, null);
const initialCollapsed = readJSON<boolean>(LS.collapsed, false);

export interface ShellState {
  repos: RepoNode[];
  expanded: Set<string>;
  selection: SidebarSelection | null;
  sidebarCollapsed: boolean;

  setRepos: (repos: RepoNode[]) => void;
  toggleExpand: (key: string) => void;
  select: (repo: string, section: RepoSection, leaf: LeafId) => void;
  clearSelection: () => void;
  toggleSidebar: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  repos: [],
  expanded: initialExpanded,
  selection: initialSelection,
  sidebarCollapsed: initialCollapsed,

  setRepos: (repos) => set({ repos }),

  toggleExpand: (key) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeJSON(LS.expanded, Array.from(next));
      return { expanded: next };
    }),

  select: (repo, section, leaf) => {
    const selection: SidebarSelection = { repo, section, leaf };
    writeJSON(LS.selection, selection);
    set({ selection });
  },

  clearSelection: () => {
    writeJSON(LS.selection, null);
    set({ selection: null });
  },

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      writeJSON(LS.collapsed, next);
      return { sidebarCollapsed: next };
    }),
}));

// Narrow selectors keep components from re-rendering on unrelated slice changes
// (react-best-practices: rerender-defer-reads).
export const selectActiveSection = (state: ShellState) => state.selection;
export const selectRepos = (state: ShellState) => state.repos;
export const selectExpanded = (state: ShellState) => state.expanded;
export const selectSidebarCollapsed = (state: ShellState) => state.sidebarCollapsed;
