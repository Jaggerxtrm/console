import { create } from "zustand";
import type { BeadIssue } from "../../types/beads.ts";

interface BeadSideDrawerState {
  beadId: string | null;
  projectId: string | null;
  issueById: Map<string, BeadIssue>;
  open: (beadId: string) => void;
  close: () => void;
  setContext: (projectId: string | null, issueById: Map<string, BeadIssue>) => void;
}

export const useBeadSideDrawer = create<BeadSideDrawerState>((set) => ({
  beadId: null,
  projectId: null,
  issueById: new Map(),
  open: (beadId) => set({ beadId }),
  close: () => set({ beadId: null }),
  setContext: (projectId, issueById) => set({ projectId, issueById }),
}));

export const beadSideDrawer = {
  open: (beadId: string) => useBeadSideDrawer.getState().open(beadId),
  close: () => useBeadSideDrawer.getState().close(),
};
