// Single edge component for the React Flow viewport. Style + marker per edge type
// come from EDGE_STYLE_VARS — the same SSOT the legacy SVG renderer used.
// .3 will polish marker geometry / label readability; this is the functional pass.

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { GraphEdgeType } from "../../../../../types/graph.ts";
import { EDGE_STYLE_VARS } from "../edge-styles.ts";

export interface CustomEdgeData extends Record<string, unknown> {
  edgeType: GraphEdgeType;
}

export function CustomEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
  } = props;
  const edgeType = (data as CustomEdgeData | undefined)?.edgeType ?? "blocks";
  const style = EDGE_STYLE_VARS[edgeType];

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // related edges have no arrowhead (informational only)
  const markerEnd = edgeType === "related" ? undefined : `url(#g-arrow-${edgeType})`;

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
          fill: "none",
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -110%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "none",
            fontSize: 9,
            color: style.token,
            fontFamily: "var(--font-mono)",
            background: "var(--surface-primary)",
            padding: "0 3px",
            borderRadius: 2,
            opacity: 0.9,
          }}
          className={`g-elabel edge-${edgeType}`}
        >
          {edgeType === "parent-child" ? "parent" : edgeType}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
