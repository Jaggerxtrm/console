// Programme entity inspector drawer state (adapted BeadSideDrawer pattern).
// Read-only: no BeadMutationPanel, no delete/status mutations.

import { create } from "zustand";
import type { ProgrammeNode } from "../../../../types/programme.ts";

export type ProgrammeDrawerTab = "overview" | "lineage" | "evidence" | "github" | "metadata" | "changes";

export interface ProgrammeDrawerTarget {
  nodeId: string;
  tab?: ProgrammeDrawerTab;
}

interface ProgrammeDrawerState {
  nodeId: string | null;
  tab: ProgrammeDrawerTab;
  backStack: string[];
  width: number;
  open: (target: string | ProgrammeDrawerTarget) => void;
  back: () => void;
  close: () => void;
  setTab: (tab: ProgrammeDrawerTab) => void;
  setWidth: (width: number) => void;
  setContext: (nodes: ProgrammeNode[]) => void;
}

export const useProgrammeDrawer = create<ProgrammeDrawerState>((set) => ({
  nodeId: null,
  tab: "overview",
  backStack: [],
  width: 480,
  open: (target) => set((state) => {
    const next = typeof target === "string" ? { nodeId: target } : target;
    const backStack = state.nodeId && state.nodeId !== next.nodeId ? [...state.backStack, state.nodeId] : state.backStack;
    return { nodeId: next.nodeId, tab: next.tab ?? "overview", backStack };
  }),
  back: () => set((state) => {
    if (state.backStack.length === 0) return { nodeId: null, backStack: [] };
    const backStack = [...state.backStack];
    const previous = backStack.pop()!;
    return { nodeId: previous, backStack };
  }),
  close: () => set({ nodeId: null, backStack: [] }),
  setTab: (tab) => set({ tab }),
  setWidth: (width) => set({ width: Math.min(Math.max(width, 360), 720) }),
  setContext: () => {},
}));
