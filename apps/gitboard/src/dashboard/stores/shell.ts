// Unified IDE-shell store (forge-7xu rebuild).
// Holds repo list, current selection (surface + tab + repo), sidebar collapse state.
// Persists selection + sidebarCollapsed to localStorage.

import { create } from "zustand";
import type {
  DrawerTab,
  RepoNode,
  SidebarSelection,
  Surface,
  TabId,
  ThemeMode,
} from "../../types/shell.ts";
import { DEFAULT_TAB } from "../../types/shell.ts";

const LS = {
  selection: "forge-5w9:selection",
  collapsed: "forge-5w9:sidebarCollapsed",
  theme: "forge-vk47:theme",
  drawerOpen: "forge-gud9:drawerOpen",
  drawerHeight: "forge-gud9:drawerHeight",
  drawerTab: "forge-gud9:drawerTab",
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
const initialTheme = readJSON<ThemeMode>(LS.theme, "dark");
const initialDrawerOpen = readJSON<boolean>(LS.drawerOpen, false);
function defaultDrawerHeight() {
  return typeof window !== "undefined" ? Math.floor(window.innerHeight * 0.75) : 600;
}
const initialDrawerHeight = readJSON<number | null>(LS.drawerHeight, null) ?? defaultDrawerHeight();
const initialDrawerTab = readJSON<DrawerTab>(LS.drawerTab, "logs");

export interface ShellState {
  repos: RepoNode[];
  selection: SidebarSelection;
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  drawerOpen: boolean;
  drawerHeight: number;
  drawerTab: DrawerTab;

  setRepos: (repos: RepoNode[]) => void;
  setSurface: (surface: Surface) => void;       // switching surface resets tab to default
  setTab: (tab: TabId) => void;
  setRepo: (repo: string | null) => void;
  toggleSidebar: () => void;
  toggleTheme: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerHeight: (height: number) => void;
  setDrawerTab: (tab: DrawerTab) => void;
}

export const useShellStore = create<ShellState>((set) => ({
  repos: [],
  selection: initialSelection,
  sidebarCollapsed: initialCollapsed,
  theme: initialTheme === "light" ? "light" : "dark",
  drawerOpen: initialDrawerOpen,
  drawerHeight: initialDrawerHeight,
  drawerTab: initialDrawerTab,

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

  toggleTheme: () =>
    set((state) => {
      const next: ThemeMode = state.theme === "dark" ? "light" : "dark";
      writeJSON(LS.theme, next);
      return { theme: next };
    }),

  setDrawerOpen: (open) =>
    set(() => {
      writeJSON(LS.drawerOpen, open);
      return { drawerOpen: open };
    }),

  setDrawerHeight: (height) =>
    set(() => {
      const maxHeight = typeof window !== "undefined" ? window.innerHeight - 24 : 600;
      const next = Math.max(120, Math.min(maxHeight, Math.round(height)));
      writeJSON(LS.drawerHeight, next);
      return { drawerHeight: next };
    }),

  setDrawerTab: (tab) =>
    set(() => {
      writeJSON(LS.drawerTab, tab);
      return { drawerTab: tab };
    }),
}));

export const selectSelection = (s: ShellState) => s.selection;
export const selectRepos = (s: ShellState) => s.repos;
export const selectSidebarCollapsed = (s: ShellState) => s.sidebarCollapsed;
export const selectTheme = (s: ShellState) => s.theme;
