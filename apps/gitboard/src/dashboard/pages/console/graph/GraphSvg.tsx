// Compact single-row node — each rect is sized to its actual content. NO trailing
// whitespace, NO table layout, items pack with 1-space-max gap (operator spec).
//
//   priority-band ◐ forge-px57 P1 · ● chain/ed51e9 · wait
//
// Edges = cubic bezier with type-colored stroke + midpoint label (hover-only).

import { useMemo, useState } from "react";
import { EDGE_STYLE_VARS } from "./edge-styles.ts";
import type { LayoutEdge, LayoutNode } from "./layout.ts";
import { categoryFor, shortJobId, type AgentCategory } from "./agent-roles.ts";
import type { GraphSpecialist } from "../../../../types/graph.ts";

interface GraphSvgProps {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  specialists: Map<string, GraphSpecialist>;
  onNodeClick: (beadId: string) => void;
  /** Width per node id (computed in Graph.tsx so layout & render agree on column packing). */
  nodeWidths: Map<string, number>;
}

const NODE_H = 24;
const LAYER_LABEL_OFFSET = 22;
const PX_BAND = 3;
const PX_GAP = 5; // "1 space max" — JBM 10.5px space ≈ 5px
const GLYPH_W = 11;
const PTAG_W = 17; // "P0".."P4"
const SEP_W = 6;
const PAD_RIGHT = 6;

const EDGE_LABEL: Record<string, string> = {
  blocks: "blocks",
  "caused-by": "caused-by",
  validates: "validates",
  supersedes: "supersedes",
  "discovered-from": "discovered-from",
  tracks: "tracks",
  until: "until",
  "parent-child": "parent",
  related: "related",
};

export function GraphSvg({ nodes, edges, specialists, onNodeClick, nodeWidths }: GraphSvgProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const activeNodeIds = useMemo(
    () => new Set(edges.flatMap((edge) => (edge.from === hovered || edge.to === hovered ? [edge.from, edge.to] : []))),
    [edges, hovered],
  );
  const activeEdges = useMemo(
    () => new Set(edges.filter((edge) => edge.from === hovered || edge.to === hovered).map((edge) => `${edge.from}->${edge.to}:${edge.type}`)),
    [edges, hovered],
  );

  const layerBoundaries = useMemo(() => {
    const byLayer = new Map<number, { minX: number; maxX: number; count: number }>();
    for (const n of nodes) {
      const w = nodeWidths.get(n.id) ?? 200;
      const e = byLayer.get(n.layer);
      if (!e) byLayer.set(n.layer, { minX: n.x, maxX: n.x + w, count: 1 });
      else byLayer.set(n.layer, { minX: Math.min(e.minX, n.x), maxX: Math.max(e.maxX, n.x + w), count: e.count + 1 });
    }
    return [...byLayer.entries()].sort((a, b) => a[0] - b[0]);
  }, [nodes, nodeWidths]);

  const overallMinY = useMemo(() => (nodes.length ? Math.min(...nodes.map((n) => n.y)) - LAYER_LABEL_OFFSET : 0), [nodes]);
  const overallMaxY = useMemo(() => (nodes.length ? Math.max(...nodes.map((n) => n.y + NODE_H)) + 10 : 0), [nodes]);

  return (
    <>
      <defs>
        {/*
          markerUnits="userSpaceOnUse" pins all markers to a fixed visual size regardless
          of stroke width. refX < markerWidth so the marker visibly OVERLAPS into the card
          by 2-3px — unambiguously attached for every edge type.

          (Previous bug: refX > markerWidth placed the marker entirely OUTSIDE the card,
          left of the path endpoint — making it look floating.)
        */}
        {(["blocks", "supersedes", "discovered-from", "validates", "caused-by", "tracks", "until"] as const).map((type) => (
          <marker
            key={type}
            id={`graph-arrow-${type}`}
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
        {/* parent-child: solid dot, fixed size, overlapping card by ~1.5px */}
        <marker
          id="graph-arrow-parent-child"
          markerWidth="7"
          markerHeight="7"
          refX="5"
          refY="3.5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <circle cx="3.5" cy="3.5" r="3" fill={EDGE_STYLE_VARS["parent-child"].token} />
        </marker>
      </defs>

      <g className="graph-layer-guides">
        {layerBoundaries.slice(0, -1).map(([layer, box], i) => {
          const nextBox = layerBoundaries[i + 1][1];
          const midX = (box.maxX + nextBox.minX) / 2;
          return <line key={`guide-${layer}`} x1={midX} x2={midX} y1={overallMinY} y2={overallMaxY} className="graph-layer-guide" />;
        })}
      </g>

      <g className="graph-column-labels">
        {layerBoundaries.map(([layer, box]) => (
          <text key={`lbl-${layer}`} x={box.minX} y={overallMinY + 12} className="graph-column-label">
            {layer === 0 ? `l0 · ready · ${box.count}` : `l${layer} · waiting · ${box.count}`}
          </text>
        ))}
      </g>

      <g className="graph-edges">
        {edges.map((edge) => {
          const key = `${edge.from}->${edge.to}:${edge.type}`;
          const style = EDGE_STYLE_VARS[edge.type];
          const isActive = hovered ? activeEdges.has(key) : false;
          const dim = hovered ? (isActive ? 1 : 0.1) : 0.75;
          const [p0, p1, p2, p3] = edge.points;
          const d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
          const arrow = edge.type === "related" ? undefined : `url(#graph-arrow-${edge.type})`;
          const mx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
          const my = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
          return (
            <g key={key} className={`graph-edge edge-${edge.type}${isActive ? " is-active" : ""}`} style={{ opacity: dim }}>
              <path d={d} fill="none" stroke={style.token} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" markerEnd={arrow} />
              {isActive ? (
                <text x={mx} y={my - 4} className={`graph-edge-label edge-label-${edge.type}`} textAnchor="middle">
                  {EDGE_LABEL[edge.type]}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>

      <g className="graph-nodes">
        {nodes.map((node) => {
          const isDimmed = hovered ? !activeNodeIds.has(node.id) : false;
          const isClosed = node.status === "closed";
          const isSuperseded = !!node.superseded_by;
          const specialist = specialists.get(node.id) ?? null;
          const isRunning = specialist?.status === "running";
          const isEpic = node.type === "epic";
          const prefix = idPrefix(node.id);
          const suffix = idSuffix(node.id);
          const agentCat: AgentCategory = categoryFor(specialist?.role);
          const w = nodeWidths.get(node.id) ?? 200;

          const classes = [
            "graph-node",
            isDimmed ? "is-dimmed" : "",
            isClosed ? "is-closed" : "",
            isSuperseded ? "is-superseded" : "",
            isRunning ? "is-running" : "",
            isEpic ? "is-epic" : "",
            `state-${node.status}`,
            `p-${node.priority}`,
            specialist ? `agent-${agentCat} agent-status-${specialist.status}` : "",
          ]
            .filter(Boolean)
            .join(" ");

          const midY = NODE_H / 2;
          // Pack left-to-right with PX_GAP between each element.
          let x = PX_BAND + PX_GAP;
          const glyphCx = x + GLYPH_W / 2;
          x += GLYPH_W + PX_GAP;
          const idX = x;
          x += idPixelLen(node.id) + PX_GAP;
          const pTagX = x;
          x += PTAG_W + PX_GAP;
          const sepCx = x + SEP_W / 2;
          x += SEP_W + PX_GAP;
          const tailX = x;

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              className={classes}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((curr) => (curr === node.id ? null : curr))}
              onClick={() => onNodeClick(node.id)}
            >
              <rect className="graph-node-card" x="0" y="0" width={w} height={NODE_H} rx="2" />
              <rect className="graph-node-priority" x="0" y="0" width={PX_BAND} height={NODE_H} />
              <text className="graph-node-glyph" x={glyphCx} y={midY} dominantBaseline="middle" textAnchor="middle">
                {stateGlyph(node)}
              </text>
              <text className="graph-node-id" x={idX} y={midY} dominantBaseline="middle">
                <tspan className="graph-node-id-prefix">{prefix}</tspan>
                <tspan className="graph-node-id-suffix">{suffix}</tspan>
              </text>
              <text className={`graph-node-tag p-${node.priority}`} x={pTagX} y={midY} dominantBaseline="middle">
                {`P${node.priority}`}
              </text>
              <circle className="graph-node-sep" cx={sepCx} cy={midY} r="1.2" />
              {specialist ? (
                <g className="graph-node-agent" transform={`translate(${tailX}, ${midY - 6.5})`}>
                  <circle className="graph-node-agent-dot" cx="2.5" cy="6.5" r="2.4" />
                  <text className="graph-node-agent-text" x="9" y="6.5" dominantBaseline="middle">
                    <tspan className="graph-node-agent-role">{specialist.role}</tspan>
                    <tspan className="graph-node-agent-sep">/</tspan>
                    <tspan className="graph-node-agent-id">{shortJobId(specialist.job_id)}</tspan>
                    <tspan className="graph-node-agent-sep"> · </tspan>
                    <tspan className={statusTspanClass(specialist.status)}>{statusShort(specialist.status)}</tspan>
                  </text>
                </g>
              ) : (
                <text className="graph-node-meta" x={tailX} y={midY} dominantBaseline="middle">
                  {compactStatus(node)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </>
  );
}

// ---- width computation (exported so Graph.tsx can pre-compute) ----

export function computeNodeWidth(node: { id: string; priority: number; status: string; type: string }, specialist: GraphSpecialist | null): number {
  // Same packing as the renderer above. Tail = either agent badge or compact status text.
  const idW = idPixelLen(node.id);
  const tail = specialist
    ? // dot(5) + gap(3) + "role/jobshort · status" width
      5 + 3 + textWidth(`${specialist.role}/${shortJobId(specialist.job_id)} · ${statusShort(specialist.status)}`, 5.7)
    : textWidth(compactStatus(node as never), 5.7);
  // band + gap + glyph + gap + id + gap + Ptag + gap + sep + gap + tail + padRight
  return PX_BAND + PX_GAP + GLYPH_W + PX_GAP + idW + PX_GAP + PTAG_W + PX_GAP + SEP_W + PX_GAP + tail + PAD_RIGHT;
}

function stateGlyph(node: LayoutNode): string {
  if (node.superseded_by) return "✕";
  if (node.type === "epic") return "◈";
  return ({ open: "◯", in_progress: "◐", blocked: "◇", closed: "✓", deferred: "◈" } as Record<string, string>)[node.status] ?? "◯";
}
function idPrefix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(0, i + 1) : ""; }
function idSuffix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(i + 1) : id; }
function idPixelLen(id: string): number { return Math.ceil(id.length * 6.4); }
function textWidth(text: string, perChar: number): number { return Math.ceil(text.length * perChar); }

function compactStatus(node: LayoutNode): string {
  // open / in progress / blocked / closed / deferred
  return node.status.replace("_", " ");
}
function statusShort(status: string): string {
  return ({ running: "run", waiting: "wait", starting: "start", done: "done", error: "err", cancelled: "cancel" } as Record<string, string>)[status] ?? status;
}
function statusTspanClass(status: string): string {
  if (status === "running") return "graph-node-agent-status";
  if (status === "error" || status === "cancelled") return "graph-node-agent-status-err";
  return "graph-node-agent-status-dim";
}
