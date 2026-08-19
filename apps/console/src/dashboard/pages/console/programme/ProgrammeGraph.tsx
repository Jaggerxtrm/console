// Programme Graph V2 — native React Flow + Dagre surface for the programme
// read model (EXP-020). Reuses the Console graph idioms (ReactFlow pane,
// fit/pan/zoom, structural vs noise edges, NOW strip, orphans, deferred
// buckets) and adds: focused 2-hop neighborhood (collision-safe, traversed by
// graph node id), an explicit All programme mode, a full-viewport pane (the
// entity drawer is an overlay and never resizes the canvas), edge labels only
// in the focused neighborhood, a selected-node context bar, and Δ change
// chips (changesEntityKeys comes from the changes slice — never built here).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, type Edge, type Node } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { ProgrammeEdge, ProgrammeGraph, ProgrammeNode, ProgrammeSnapshot } from "../../../../types/programme.ts";
import { useProgrammeDrawer } from "./programme-drawer.ts";
import { useProgrammeContext } from "./context-buffer.ts";
import { displayIdOf, displayLabel } from "./identity.ts";
import "./programme.css";

const NODE_W = 240;
const NODE_H = 46;
const PAD = 24;

const KIND_RANK: Record<string, number> = {
  workstream: 0,
  assignment: 1,
  decision: 2,
  actor: 3,
  collision: 3,
  state: 4,
  journal: 4,
  publication: 5,
  research: 5,
  proposal: 5,
  repository: 6,
  jira: 6,
};

const KIND_LABEL: Record<string, string> = {
  workstream: "Workstreams",
  assignment: "OPS / EXP",
  decision: "ADRs",
  actor: "Actors",
  collision: "ID collisions",
  state: "State",
  journal: "Journals",
  publication: "Publication",
  research: "Research",
  proposal: "Proposals",
  repository: "Repositories",
  jira: "Jira",
};

const KIND_COLOR: Record<string, string> = {
  workstream: "var(--accent-blue)",
  assignment: "var(--accent-amber)",
  decision: "var(--accent-purple)",
  actor: "var(--accent-green)",
  collision: "var(--accent-red)",
  state: "#0ea5e9",
  journal: "#14b8a6",
  publication: "#8b5cf6",
  research: "#f97316",
  proposal: "#ec4899",
  repository: "#64748b",
  jira: "#2563eb",
};

const DEFAULT_KINDS = new Set(["workstream", "assignment", "decision", "actor", "state", "journal", "publication", "research", "proposal", "repository", "jira"]);

interface FlowNodeData extends Record<string, unknown> {
  node: ProgrammeNode;
  focused?: boolean;
  dimmed?: boolean;
  changed?: boolean;
}

interface FlowNode extends Node<FlowNodeData, "programme"> {}
interface FlowEdge extends Edge<{ edge: ProgrammeEdge }> {}

interface FocusCtx {
  /** Focused entity key (collision-safe graph node id). */
  id: string;
  /** 2-hop neighborhood node ids (includes the focused node). */
  nodeIds: Set<string>;
}

/** 2-hop BFS over graph edges, traversed by graph node id (collision-safe),
 * respecting the current kind filter for neighbors. The focused node itself
 * is always kept so the anchor never vanishes mid-focus. */
function twoHopNeighborhood(graph: ProgrammeGraph, startId: string, kinds: Set<string>): Set<string> {
  const result = new Set<string>([startId]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let frontier = [startId];
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.edges) {
        let other: string | null = null;
        if (e.source === id && e.target !== id) other = e.target;
        else if (e.target === id && e.source !== id) other = e.source;
        if (!other || result.has(other)) continue;
        const n = byId.get(other);
        if (n && kinds.has(n.kind)) {
          result.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return result;
}

function buildFlow(
  graph: ProgrammeGraph,
  kinds: Set<string>,
  mode: "strong" | "all",
  focus: FocusCtx | null,
  changes: Set<string> | undefined,
): { nodes: FlowNode[]; edges: FlowEdge[]; width: number; height: number } {
  const visible = focus
    ? graph.nodes.filter((n) => focus.nodeIds.has(n.id))
    : graph.nodes.filter((n) => kinds.has(n.kind));
  const ids = new Set(visible.map((n) => n.id));
  // Labels render only in the focused 2-hop neighborhood (requirement 8).
  const showLabels = focus != null;
  // Weak edges stay hidden in Structural mode, except edges touching the
  // focused node — those render as dashed, muted derived context (req 7).
  const visibleEdges = graph.edges.filter((e) =>
    ids.has(e.source) && ids.has(e.target) &&
    (mode === "all" || e.strength === "strong" || (focus != null && (e.source === focus.id || e.target === focus.id))),
  );

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 90, marginx: 0, marginy: 0 });
  for (const n of visible) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of visibleEdges) {
    if (e.strength !== "strong") continue;
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of visible) {
    const p = g.node(n.id);
    if (!p) continue;
    const x = p.x - NODE_W / 2;
    const y = p.y - NODE_H / 2;
    pos.set(n.id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = NODE_W; maxY = NODE_H; }
  const offX = -minX + PAD;
  const offY = -minY + PAD;

  const nodes: FlowNode[] = visible.map((n) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: "programme" as const,
      position: { x: p.x + offX, y: p.y + offY },
      data: {
        node: n,
        focused: focus?.id === n.id,
        dimmed: focus != null && focus.id !== n.id,
        changed: changes?.has(n.id) ?? false,
      },
      draggable: false,
      selectable: false,
    };
  });

  const edges: FlowEdge[] = visibleEdges.map((e, i) => ({
    id: `${e.source}::${e.target}::${e.relation}::${i}`,
    source: e.source,
    target: e.target,
    label: showLabels ? e.relation : undefined,
    type: "default",
    data: { edge: e },
    style: e.strength === "weak" ? { strokeDasharray: "4 5", opacity: 0.55 } : undefined,
    labelStyle: { fontSize: 9, fill: "var(--text-muted)" },
    labelBgStyle: { fill: "var(--surface-primary)" },
    labelBgPadding: [3, 2] as [number, number],
    labelBgBorderRadius: 3,
    zIndex: 1,
  }));

  return { nodes, edges, width: maxX - minX + 2 * PAD, height: maxY - minY + 2 * PAD };
}

function statusBadgeClass(status: string): string {
  const slug = status.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `pd-badge pd-badge-${slug}`;
}

function ProgrammeNodeView({ data }: { data: FlowNodeData }) {
  const node = data.node;
  const color = KIND_COLOR[node.kind] ?? "var(--text-muted)";
  const title = (node.title ?? node.id).replace(/\s+/g, " ");
  const short = title.length > 34 ? title.slice(0, 33) + "…" : title;
  const cls = ["pg-node", data.focused ? "pg2-node-focused" : "", data.dimmed ? "pg2-node-dimmed" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ width: NODE_W, height: NODE_H }}>
      <span className="pg-node-dot" style={{ background: color }} />
      <div className="pg-node-id">{node.id}</div>
      <div className="pg-node-title" title={title}>{short}</div>
      {data.changed ? <span className="pg2-delta" title="changed since previous snapshot">Δ</span> : null}
      {node.kind === "collision" ? <span className="pg-node-tag">collision</span> : null}
    </div>
  );
}

export function ProgrammeGraphView({
  graph,
  snapshot,
  changesEntityKeys,
}: {
  graph: ProgrammeGraph;
  snapshot: ProgrammeSnapshot;
  changesEntityKeys?: Set<string>;
}) {
  const [kinds, setKinds] = useState<Set<string>>(new Set(DEFAULT_KINDS));
  const [mode, setMode] = useState<"strong" | "all">("strong");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [allProgramme, setAllProgramme] = useState(false);
  const open = useProgrammeDrawer((s) => s.open);
  const drawerOpen = useProgrammeDrawer((s) => Boolean(s.nodeId));
  const addNode = useProgrammeContext((s) => s.addNode);

  // All programme mode overrides focus: full graph, no context bar.
  const focusedNode = useMemo(
    () => (focusedId && !allProgramme ? graph.nodes.find((n) => n.id === focusedId) ?? null : null),
    [graph, focusedId, allProgramme],
  );
  const focusNodeIds = useMemo(
    () => (focusedNode ? twoHopNeighborhood(graph, focusedNode.id, kinds) : null),
    [graph, focusedNode, kinds],
  );

  const flow = useMemo(
    () => buildFlow(graph, kinds, mode, focusedNode && focusNodeIds ? { id: focusedNode.id, nodeIds: focusNodeIds } : null, changesEntityKeys),
    [graph, kinds, mode, focusedNode, focusNodeIds, changesEntityKeys],
  );

  // Escape clears focus — unless the inspector drawer is open (it owns Escape).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !drawerOpen) setFocusedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const edgeIds = useMemo(() => new Set(graph.edges.flatMap((e) => [e.source, e.target])), [graph]);
  const orphans = useMemo(() => graph.nodes.filter((n) => !edgeIds.has(n.id) && kinds.has(n.kind)), [graph, edgeIds, kinds]);
  const now = useMemo(() => {
    const statuses = new Set(["IN_PROGRESS", "ACTIVE", "AUTHORIZED", "RUNNING"]);
    return graph.nodes.filter((n) => kinds.has(n.kind) && n.status && statuses.has(n.status.toUpperCase()));
  }, [graph, kinds]);
  const deferred = useMemo(() => graph.nodes.filter((n) => kinds.has(n.kind) && n.status && ["CLOSED", "COMPLETED", "SUPERSEDED"].includes(n.status.toUpperCase())), [graph, kinds]);

  const addToContext = (node: ProgrammeNode) => {
    const visibleIds = focusNodeIds ?? new Set(graph.nodes.filter((n) => kinds.has(n.kind)).map((n) => n.id));
    const incident = graph.edges.filter((e) =>
      (e.source === node.id || e.target === node.id) && visibleIds.has(e.source) && visibleIds.has(e.target));
    addNode(snapshot, node, {
      source_view: "graph",
      selectedRelations: incident.filter((e) => e.strength === "strong"),
      derivedRelations: incident.filter((e) => e.strength === "weak"),
    });
  };

  if (graph.nodes.length === 0) {
    return <div className="pd-empty">Programme graph is empty — snapshot unavailable.</div>;
  }

  const flowKey = `${flow.nodes.length}:${flow.edges.length}:${mode}:${focusedId ?? "unfocused"}:${allProgramme ? "all" : "focused"}`;

  return (
    <div className="pg-app pg2-fit">
      <div className="pg-toolbar">
        <div className="pg-filters">
          {Object.entries(KIND_LABEL).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className={kinds.has(kind) ? "pg-filter is-active" : "pg-filter"}
              onClick={() => {
                const next = new Set(kinds);
                if (next.has(kind)) next.delete(kind);
                else next.add(kind);
                setKinds(next);
              }}
            >
              <span className="pg-filter-dot" style={{ background: KIND_COLOR[kind] }} />
              {label}
            </button>
          ))}
        </div>
        <div className="pg-toolbar-right">
          <div className="pg2-mode" role="group" aria-label="View mode">
            <button type="button" className={!allProgramme ? "pg-filter is-active" : "pg-filter"} onClick={() => setAllProgramme(false)}>Focus</button>
            <button type="button" className={allProgramme ? "pg-filter is-active" : "pg-filter"} onClick={() => setAllProgramme(true)}>All programme</button>
          </div>
          <div className="pg2-mode" role="group" aria-label="Reference mode">
            <button type="button" className={mode === "strong" ? "pg-filter is-active" : "pg-filter"} onClick={() => setMode("strong")}>Structural</button>
            <button type="button" className={mode === "all" ? "pg-filter is-active" : "pg-filter"} onClick={() => setMode("all")}>All refs</button>
          </div>
        </div>
      </div>
      {focusedNode ? (
        <div className="pg2-ctxbar" data-testid="pg2-ctxbar">
          <div className="pg2-ctxbar-main">
            <span className="pg2-ctxbar-id">{displayIdOf(focusedNode)}</span>
            <span className="pg2-ctxbar-title">{focusedNode.title}</span>
            <span className="pg2-ctxbar-kind">{focusedNode.kind}</span>
            {focusedNode.status ? <span className={statusBadgeClass(focusedNode.status)}>{focusedNode.status}</span> : null}
            {focusedNode.source_path ? <span className="pg2-ctxbar-path">{displayLabel(focusedNode)}</span> : null}
          </div>
          <div className="pg2-ctxbar-actions">
            <button type="button" className="pg2-btn" onClick={() => open(focusedNode.id)}>Open inspector</button>
            <button type="button" className="pg2-btn" onClick={() => addToContext(focusedNode)}>Add to context</button>
            <button type="button" className="pg2-btn" onClick={() => setFocusedId(null)}>Clear focus</button>
          </div>
        </div>
      ) : null}
      <div className="pg-stats">
        {graph.nodes.length} nodes · {graph.edges.length} relations · {graph.identity_collisions.length} identity collisions
        {focusedNode ? <span className="pg-stats-muted"> · focused 2-hop: {flow.nodes.length} nodes / {flow.edges.length} relations</span> : null}
        <span className="pg-stats-muted"> · Structural hides weak reference edges. Full relations may contain cycles.</span>
      </div>
      {graph.identity_collisions.length > 0 ? (
        <div className="pg-banner">
          <strong>Identity collision:</strong> {graph.identity_collisions.map((c) => `${c.id} ×${c.records.length}`).join(" · ")}. The graph preserves the ambiguity; fix the canonical IDs rather than guessing ownership.
        </div>
      ) : null}
      {now.length > 0 ? (
        <section className="pg-now">
          <div className="pg-now-lbl"><span>◐</span> now · active state</div>
          <div className="pg-now-rows">
            {now.slice(0, 24).map((n) => <NodeChip key={n.id} node={n} onOpen={() => open(n.id)} />)}
          </div>
        </section>
      ) : null}
      <div className="pg-pane pg2-pane">
        <ReactFlowProvider>
          <ReactFlow
            key={flowKey}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={{ programme: ProgrammeNodeView }}
            onNodeClick={(_, node) => {
              const n = (node.data as FlowNodeData).node;
              // Clicking the already-focused node opens the inspector; any
              // other node click focuses it (exiting All programme mode).
              if (!allProgramme && focusedId === n.id) { open(n.id); return; }
              setFocusedId(n.id);
              setAllProgramme(false);
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            zoomOnScroll={false}
            zoomOnPinch
            panOnScroll={false}
            panOnDrag
            preventScrolling={false}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="var(--border-subtle)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      {orphans.length > 0 ? (
        <section className="pg-orphans">
          <div className="pg-orphans-hd"><span>orphans</span><em>{orphans.length} · no edges</em></div>
          <div className="pg-orphans-grid">
            {orphans.slice(0, 24).map((n) => <NodeChip key={n.id} node={n} onOpen={() => open(n.id)} />)}
          </div>
        </section>
      ) : null}
      {deferred.length > 0 ? (
        <details className="pg-bucket">
          <summary><span>▸</span> deferred / closed <em>{deferred.length}</em></summary>
          <div className="pg-orphans-grid">
            {deferred.slice(0, 50).map((n) => <NodeChip key={n.id} node={n} onOpen={() => open(n.id)} />)}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function NodeChip({ node, onOpen }: { node: ProgrammeNode; onOpen: () => void }) {
  const color = KIND_COLOR[node.kind] ?? "var(--text-muted)";
  return (
    <button type="button" className="pg-chip" onClick={onOpen} title={`${node.id} — ${node.title}`}>
      <span className="pg-chip-dot" style={{ background: color }} />
      <span className="pg-chip-id">{node.id}</span>
      <span className="pg-chip-title">{node.title}</span>
    </button>
  );
}

export function ProgrammeGraphShell({
  graph,
  snapshot,
  changesEntityKeys,
}: {
  graph: ProgrammeGraph;
  snapshot: ProgrammeSnapshot;
  changesEntityKeys?: Set<string>;
}): ReactNode {
  return <ProgrammeGraphView graph={graph} snapshot={snapshot} changesEntityKeys={changesEntityKeys} />;
}
