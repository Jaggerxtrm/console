// Unified IDE-shell store (forge-7xu rebuild).
// Holds repo list, current selection (surface + tab + repo), sidebar collapse state.
// Persists selection + sidebarCollapsed to localStorage.

import { create } from "zustand";
import type {
  RepoNode,
  SidebarSelection,
  Surface,
  TabId,
} from "../../types/shell.ts";
import { DEFAULT_TAB } from "../../types/shell.ts";

const LS = {
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

const initialSelection = readJSON<SidebarSelection>(LS.selection, {
  surface: "github",
  tab: DEFAULT_TAB.github,
  repo: null,
});
const initialCollapsed = readJSON<boolean>(LS.collapsed, false);

export interface ShellState {
  repos: RepoNode[];
  selection: SidebarSelection;
  sidebarCollapsed: boolean;

  setRepos: (repos: RepoNode[]) => void;
  setSurface: (surface: Surface) => void;       // switching surface resets tab to default
  setTab: (tab: TabId) => void;
  setRepo: (repo: string | null) => void;
  toggleSidebar: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  repos: [],
  selection: initialSelection,
  sidebarCollapsed: initialCollapsed,

  setRepos: (repos) => set({ repos }),

  setSurface: (surface) =>
    set((state) => {
      const next: SidebarSelection = {
        surface,
        tab: DEFAULT_TAB[surface],
        repo: state.selection.repo,
      };
      writeJSON(LS.selection, next);
      return { selection: next };
    }),

  setTab: (tab) =>
    set((state) => {
      const next: SidebarSelection = { ...state.selection, tab };
      writeJSON(LS.selection, next);
      return { selection: next };
    }),

  setRepo: (repo) =>
    set((state) => {
      const next: SidebarSelection = { ...state.selection, repo };
      writeJSON(LS.selection, next);
      return { selection: next };
    }),

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      writeJSON(LS.collapsed, next);
      return { sidebarCollapsed: next };
    }),
}));

export const selectSelection = (s: ShellState) => s.selection;
export const selectRepos = (s: ShellState) => s.repos;
export const selectSidebarCollapsed = (s: ShellState) => s.sidebarCollapsed;
