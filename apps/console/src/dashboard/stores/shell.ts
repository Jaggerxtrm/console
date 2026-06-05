// Unified IDE-shell store (forge-7xu rebuild).
// Holds repo list, current selection (surface + tab + repo), sidebar collapse state.
// Persists selection + sidebarCollapsed to localStorage.

import { create } from "zustand";
import { logClientEvent } from "../lib/client-log.ts";
import type {
  DrawerTab,
  RepoNode,
  SidebarSelection,
  SpecialistsScope,
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
  drawerSpecialistsScope: "forge-gud9:drawerSpecialistsScope",
  sidebarState: "forge-70el:sidebarState",
  sidebarWidth: "forge-70el:sidebarWidth",
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
const initialDrawerSpecialistsScope = readJSON<SpecialistsScope>(LS.drawerSpecialistsScope, "repo");
const initialSidebarState = readJSON<{ open: boolean; beadId: string | null; jobId: string | null }>(LS.sidebarState, { open: false, beadId: null, jobId: null });
const initialSidebarWidth = readJSON<number | null>(LS.sidebarWidth, null) ?? 480;
const initialTerminalSessionId: string | null = null;
const initialTerminalReattachToken: string | null = null;
const initialTerminalOutput: string[] = [];

export interface ShellState {
  repos: RepoNode[];
  selection: SidebarSelection;
  sidebarCollapsed: boolean;
  theme: ThemeMode;
  drawerOpen: boolean;
  drawerHeight: number;
  drawerTab: DrawerTab;
  drawerSpecialistsScope: SpecialistsScope;
  sidebar: { open: boolean; beadId: string | null; jobId: string | null; width: number };
  terminalSessionId: string | null;
  terminalReattachToken: string | null;
  terminalOutput: string[];

  setRepos: (repos: RepoNode[]) => void;
  setSurface: (surface: Surface) => void;       // switching surface resets tab to default
  setTab: (tab: TabId) => void;
  setRepo: (repo: string | null) => void;
  toggleSidebar: () => void;
  toggleTheme: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerHeight: (height: number) => void;
  setDrawerTab: (tab: DrawerTab) => void;
  setDrawerSpecialistsScope: (scope: SpecialistsScope) => void;
  openSidebar: (target: { beadId: string; jobId?: string } | null) => void;
  closeSidebar: (reason?: "escape" | "x_button" | "click_out" | "store_clear") => void;
  setSidebarWidth: (width: number) => void;
  setTerminalSessionId: (sessionId: string | null) => void;
  setTerminalReattachToken: (token: string | null) => void;
  appendTerminalOutput: (chunk: string) => void;
  resetTerminalOutput: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  repos: [],
  selection: initialSelection,
  sidebarCollapsed: initialCollapsed,
  theme: initialTheme === "light" ? "light" : "dark",
  drawerOpen: initialDrawerOpen,
  drawerHeight: initialDrawerHeight,
  drawerTab: initialDrawerTab,
  drawerSpecialistsScope: initialDrawerSpecialistsScope,
  sidebar: { ...initialSidebarState, width: initialSidebarWidth },
  terminalSessionId: initialTerminalSessionId,
  terminalReattachToken: initialTerminalReattachToken,
  terminalOutput: initialTerminalOutput,

  setRepos: (repos) => set({ repos }),

  setSurface: (surface) =>
    set((state) => {
      const current = state.selection.repo ? state.repos.find((repo) => repo.fullName === state.selection.repo) : null;
      const currentSupportsSurface = surface === "github" ? current?.hasGithub : current?.hasBeads;
      const fallback = state.repos.find((repo) => (surface === "github" ? repo.hasGithub : repo.hasBeads));
      const next: SidebarSelection = {
        surface,
        tab: DEFAULT_TAB[surface],
        repo: currentSupportsSurface ? state.selection.repo : fallback?.fullName ?? null,
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

  setDrawerSpecialistsScope: (scope) =>
    set(() => {
      writeJSON(LS.drawerSpecialistsScope, scope);
      return { drawerSpecialistsScope: scope };
    }),

  openSidebar: (target) =>
    set((state) => {
      const next = target
        ? { open: true, beadId: target.beadId, jobId: target.jobId ?? null, width: state.sidebar.width }
        : { open: false, beadId: state.sidebar.beadId, jobId: state.sidebar.jobId, width: state.sidebar.width };
      if (target) {
        const isSwap = state.sidebar.open && (state.sidebar.beadId !== next.beadId || state.sidebar.jobId !== next.jobId);
        logClientEvent(isSwap ? "right_sidebar.target_swap" : "right_sidebar.opened", {
          beadId: next.beadId,
          jobId: next.jobId,
          width: next.width,
          prevBeadId: isSwap ? state.sidebar.beadId : null,
          prevJobId: isSwap ? state.sidebar.jobId : null,
        });
      } else if (state.sidebar.open) {
        logClientEvent("right_sidebar.closed", { reason: "store_clear", beadId: state.sidebar.beadId, jobId: state.sidebar.jobId });
      }
      writeJSON(LS.sidebarState, { open: next.open, beadId: next.beadId, jobId: next.jobId });
      return { sidebar: next };
    }),

  closeSidebar: (reason = "store_clear") =>
    set((state) => {
      const next = { ...state.sidebar, open: false };
      if (state.sidebar.open) logClientEvent("right_sidebar.closed", { reason, beadId: state.sidebar.beadId, jobId: state.sidebar.jobId });
      writeJSON(LS.sidebarState, { open: false, beadId: next.beadId, jobId: next.jobId });
      return { sidebar: next };
    }),

  setSidebarWidth: (width) =>
    set((state) => {
      const viewportWidth = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 768;
      const maxWidth = Math.min(740, viewportWidth - 56);
      const next = Math.max(320, Math.min(maxWidth, Math.round(width)));
      if (next !== state.sidebar.width) logClientEvent("right_sidebar.resized", { from: state.sidebar.width, to: next });
      writeJSON(LS.sidebarWidth, next);
      return { sidebar: { ...state.sidebar, width: next } };
    }),

  setTerminalSessionId: (sessionId) =>    set(() => ({ terminalSessionId: sessionId })),

  setTerminalReattachToken: (token) =>
    set(() => ({ terminalReattachToken: token })),

  appendTerminalOutput: (chunk) =>
    set((state) => ({ terminalOutput: [...state.terminalOutput, chunk].slice(-2000) })),

  resetTerminalOutput: () =>
    set(() => ({ terminalOutput: [] })),
}));

export const selectSelection = (s: ShellState) => s.selection;
export const selectRepos = (s: ShellState) => s.repos;
export const selectSidebarCollapsed = (s: ShellState) => s.sidebarCollapsed;
export const selectTheme = (s: ShellState) => s.theme;
export const selectDrawerSpecialistsScope = (s: ShellState) => s.drawerSpecialistsScope;
export const selectSidebar = (s: ShellState) => s.sidebar;
