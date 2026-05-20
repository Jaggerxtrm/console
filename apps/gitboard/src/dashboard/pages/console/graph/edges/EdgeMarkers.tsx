// Renders SVG <marker> definitions referenced by CustomEdge via url(#g-arrow-*).
// Mounted once near the React Flow viewport; markers resolve globally by id.

import { EDGE_STYLE_VARS } from "../edge-styles.ts";
import type { GraphEdgeType } from "../../../../../types/graph.ts";

const ARROW_TYPES: GraphEdgeType[] = ["blocks", "supersedes", "discovered-from", "validates", "caused-by", "tracks", "until"];

export function EdgeMarkers() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} aria-hidden>
      <defs>
        {ARROW_TYPES.map((type) => (
          <marker
            key={type}
            id={`g-arrow-${type}`}
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4.5"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0.5,1 L9,4.5 L0.5,8 z" fill={EDGE_STYLE_VARS[type].token} />
          </marker>
        ))}
        <marker id="g-arrow-parent-child" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="3" fill={EDGE_STYLE_VARS["parent-child"].token} />
        </marker>
      </defs>
    </svg>
  );
}
