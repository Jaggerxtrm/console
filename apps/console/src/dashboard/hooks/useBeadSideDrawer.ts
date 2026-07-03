import { create } from "zustand";
import type { BeadIssue, Memory } from "../../types/beads.ts";

export type BeadInspectorTab = "overview" | "lineage" | "activity" | "evidence" | "github" | "memories" | "followups";

export interface BeadInspectorTarget {
  beadId: string;
  jobId?: string | null;
  chainId?: string | null;
  issue?: BeadIssue | null;
  tab?: BeadInspectorTab;
}

interface BeadSideDrawerState {
  beadId: string | null;
  jobId: string | null;
  chainId: string | null;
  projectId: string | null;
  issueById: Map<string, BeadIssue>;
  fallbackIssue: BeadIssue | null;
  lastTarget: BeadInspectorTarget | null;
  memories: Memory[];
  tab: BeadInspectorTab;
  backStack: BeadInspectorTarget[];
  open: (target: string | BeadInspectorTarget) => void;
  reopenLast: () => void;
  back: () => void;
  close: () => void;
  setTab: (tab: BeadInspectorTab) => void;
  setContext: (projectId: string | null, issueById: Map<string, BeadIssue>, memories?: Memory[]) => void;
}

export const useBeadSideDrawer = create<BeadSideDrawerState>((set) => ({
  beadId: null,
  jobId: null,
  chainId: null,
  projectId: null,
  issueById: new Map(),
  fallbackIssue: null,
  lastTarget: null,
  memories: [],
  tab: "overview",
  backStack: [],
  open: (target) => set((state) => {
    const next = typeof target === "string" ? { beadId: target } : target;
    const current = state.beadId ? { beadId: state.beadId, jobId: state.jobId, chainId: state.chainId, issue: state.fallbackIssue } : null;
    const backStack = current && current.beadId !== next.beadId ? [...state.backStack, current] : state.backStack;
    return {
      beadId: next.beadId,
      jobId: next.jobId ?? null,
      chainId: next.chainId ?? null,
      fallbackIssue: next.issue ?? null,
      tab: next.tab ?? "overview",
      lastTarget: next,
      backStack,
    };
  }),
  reopenLast: () => set((state) => {
    if (!state.lastTarget) return state;
    return {
      beadId: state.lastTarget.beadId,
      jobId: state.lastTarget.jobId ?? null,
      chainId: state.lastTarget.chainId ?? null,
      fallbackIssue: state.lastTarget.issue ?? null,
      tab: state.lastTarget.tab ?? "overview",
    };
  }),
  back: () => set((state) => {
    const previous = state.backStack.at(-1);
    if (!previous) return state;
    return {
      beadId: previous.beadId,
      jobId: previous.jobId ?? null,
      chainId: previous.chainId ?? null,
      fallbackIssue: previous.issue ?? null,
      tab: "overview",
      backStack: state.backStack.slice(0, -1),
    };
  }),
  close: () => set({ beadId: null, jobId: null, chainId: null, fallbackIssue: null, backStack: [] }),
  setTab: (tab) => set({ tab }),
  setContext: (projectId, issueById, memories = []) => set({ projectId, issueById, memories }),
}));

export const beadSideDrawer = {
  open: (target: string | BeadInspectorTarget) => useBeadSideDrawer.getState().open(target),
  reopenLast: () => useBeadSideDrawer.getState().reopenLast(),
  close: () => useBeadSideDrawer.getState().close(),
};
