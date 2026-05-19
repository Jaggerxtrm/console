import { useMemo, useState } from "react";
import { EDGE_STYLE_VARS } from "./edge-styles.ts";
import type { LayoutEdge, LayoutNode } from "./layout.ts";

interface GraphSvgProps {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  specialists: Set<string>;
  onNodeClick: (beadId: string) => void;
}

export function GraphSvg({ nodes, edges, specialists, onNodeClick }: GraphSvgProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const activeNodeIds = useMemo(() => new Set(edges.flatMap((edge) => edge.from === hovered || edge.to === hovered ? [edge.from, edge.to] : [])), [edges, hovered]);
  const activeEdges = useMemo(() => new Set(edges.filter((edge) => edge.from === hovered || edge.to === hovered).map((edge) => `${edge.from}->${edge.to}:${edge.type}`)), [edges, hovered]);

  return (
    <>
      <defs>
        {(["blocks", "supersedes", "parent-child", "discovered-from", "validates", "caused-by", "tracks", "until"] as const).map((type) => (
          <marker key={type} id={`graph-arrow-${type}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" fill={EDGE_STYLE_VARS[type].token} />
          </marker>
        ))}
      </defs>
      <g className="graph-edges">
        {edges.map((edge) => {
          const key = `${edge.from}->${edge.to}:${edge.type}`;
          const style = EDGE_STYLE_VARS[edge.type];
          const dim = hovered ? (activeEdges.has(key) ? 1 : 0.3) : 1;
          const d = edge.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
          const arrow = edge.type === "related" ? undefined : `url(#graph-arrow-${edge.type})`;
          return <path key={key} d={d} fill="none" stroke={style.token} strokeWidth={style.width} strokeDasharray={style.dash} strokeOpacity={dim} markerEnd={arrow} />;
        })}
      </g>
      <g className="graph-nodes">
        {nodes.map((node) => {
          const isDimmed = hovered ? !activeNodeIds.has(node.id) : false;
          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              className={isDimmed ? "graph-node is-dimmed" : "graph-node"}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((curr) => (curr === node.id ? null : curr))}
              onClick={() => onNodeClick(node.id)}
            >
              <rect className={`graph-node-card ${node.status === "closed" ? "is-closed" : ""} ${node.superseded_by ? "is-superseded" : ""}`} x="0" y="0" width="240" height="52" rx="0" />
              <rect className="graph-node-priority" x="0" y="0" width="3" height="52" data-priority={node.priority} />
              {specialists.has(node.id) ? <circle className="graph-node-pulse" cx="18" cy="26" r="3" /> : null}
              <text className="graph-node-state" x="16" y="21">{stateGlyph(node.status)}</text>
              <text className="graph-node-id" x="28" y="21"><tspan className="graph-node-id-prefix">{idPrefix(node.id)}</tspan><tspan className="graph-node-id-suffix">{idSuffix(node.id)}</tspan></text>
              <text className="graph-node-title" x="28" y="39">{node.superseded_by ? <tspan className="graph-node-title-strike">{node.title}</tspan> : node.title}</text>
              {specialists.has(node.id) ? <circle className="graph-node-ring" cx="214" cy="17" r="6" /> : null}
            </g>
          );
        })}
      </g>
    </>
  );
}

function stateGlyph(status: string) {
  return ({ open: "◯", in_progress: "◐", blocked: "◇", closed: "✓", deferred: "◈" } as Record<string, string>)[status] ?? "◯";
}
function idPrefix(id: string) { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(0, i + 1) : ""; }
function idSuffix(id: string) { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(i + 1) : id; }
