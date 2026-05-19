import type { GraphEdgeType } from "./types.ts";

export const EDGE_STYLE_VARS: Record<GraphEdgeType, { token: string; width: number; dash?: string }> = {
  blocks: { token: "var(--graph-edge-blocks)", width: 1.8 },
  supersedes: { token: "var(--graph-edge-supersedes)", width: 1.6 },
  "parent-child": { token: "var(--graph-edge-parent-child)", width: 1.1 },
  "discovered-from": { token: "var(--graph-edge-discovered-from)", width: 1.3 },
  validates: { token: "var(--graph-edge-validates)", width: 1.3 },
  "caused-by": { token: "var(--graph-edge-caused-by)", width: 1.3 },
  tracks: { token: "var(--graph-edge-tracks)", width: 1.1 },
  until: { token: "var(--graph-edge-until)", width: 1.1, dash: "5 4" },
  related: { token: "var(--graph-edge-related)", width: 1 },
};
