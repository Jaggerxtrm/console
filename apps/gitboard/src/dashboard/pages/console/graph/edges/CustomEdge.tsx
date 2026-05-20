// Single edge component for the per-cluster React Flow viewports. Reads
// EDGE_STYLE_VARS (the same SSOT the legacy SVG renderer used) so token + dash
// pattern stay consistent across the graph register. Labels render as small
// mono italics with a faint surface background so they read on any track.

import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import type { GraphEdgeType } from "../../../../../types/graph.ts";
import { EDGE_STYLE_VARS } from "../edge-styles.ts";

export interface CustomEdgeData extends Record<string, unknown> {
  edgeType: GraphEdgeType;
}

// Maps edge type → short label + class. parent-child / related render WITHOUT
// labels because the dash pattern alone conveys the type, and on dense graphs
// (epic with many siblings) the labels stack on top of chips.
const EDGE_LABEL: Partial<Record<GraphEdgeType, { text: string; cls: string }>> = {
  blocks:           { text: "blocks",     cls: "blocks" },
  "caused-by":      { text: "caused",     cls: "caused" },
  validates:        { text: "validates",  cls: "validates" },
  supersedes:       { text: "supersedes", cls: "supersedes" },
  "discovered-from":{ text: "discovered", cls: "discovered" },
};

export function CustomEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const edgeType = (data as CustomEdgeData | undefined)?.edgeType ?? "blocks";
  const style = EDGE_STYLE_VARS[edgeType];

  // Same-side handles (both Left or both Right) with near-zero dx → React
  // Flow's getBezierPath collapses to a straight line because its control-
  // point offset scales with |dx|. Force a sideways bend so the path arcs
  // around chips stacked between source and target.
  let path: string;
  let labelX: number;
  let labelY: number;
  const sameSide = sourcePosition === targetPosition && (sourcePosition === Position.Left || sourcePosition === Position.Right);
  if (sameSide && Math.abs(targetX - sourceX) < 12) {
    const bend = Math.max(48, Math.min(Math.abs(targetY - sourceY) * 0.35, 160));
    const dir = sourcePosition === Position.Left ? -1 : 1;
    const c1x = sourceX + dir * bend;
    const c2x = targetX + dir * bend;
    path = `M ${sourceX},${sourceY} C ${c1x},${sourceY} ${c2x},${targetY} ${targetX},${targetY}`;
    labelX = (sourceX + 3 * c1x + 3 * c2x + targetX) / 8;
    labelY = (sourceY + targetY) / 2;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX, sourceY, sourcePosition,
      targetX, targetY, targetPosition,
    });
  }

  // related edges have no arrowhead (informational only)
  const markerEnd = edgeType === "related" ? undefined : `url(#g-arrow-${edgeType})`;
  const label = EDGE_LABEL[edgeType];
  // Lighten non-structural edges (dashed) so structural blocks/etc. read primary.
  const isAmbient = edgeType === "parent-child" || edgeType === "related" || edgeType === "tracks" || edgeType === "until";
  const strokeOpacity = isAmbient ? 0.45 : 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: style.token,
          strokeWidth: style.width,
          strokeDasharray: style.dash,
          strokeLinecap: "round",
          strokeOpacity,
          fill: "none",
        }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={`g-flow-elabel ${label.cls}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label.text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
