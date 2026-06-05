import type { GraphEdgeType } from "../../../../types/graph.ts";

// Per docs/graph/detail.md: solid = hard/causal, dashed = soft/time-bound, dotted = structural/informational.
// Dash patterns are tuned so every relationship's line is visibly continuous all the way to
// the marker — no orphaned anchors floating in a gap before the card.
export const EDGE_STYLE_VARS: Record<GraphEdgeType, { token: string; width: number; dash?: string }> = {
  blocks:            { token: "var(--graph-edge-blocks)",          width: 2.0 },
  "caused-by":       { token: "var(--graph-edge-caused-by)",       width: 1.5 },
  validates:         { token: "var(--graph-edge-validates)",       width: 1.5 },
  supersedes:        { token: "var(--graph-edge-supersedes)",      width: 1.5 },
  "discovered-from": { token: "var(--graph-edge-discovered-from)", width: 1.5 },
  tracks:            { token: "var(--graph-edge-tracks)",          width: 1.3, dash: "4 3" },
  until:             { token: "var(--graph-edge-until)",           width: 1.3, dash: "4 3" },
  "parent-child":    { token: "var(--graph-edge-parent-child)",    width: 1.2, dash: "2 2" },
  related:           { token: "var(--graph-edge-related)",         width: 1.0, dash: "2 2" },
};
