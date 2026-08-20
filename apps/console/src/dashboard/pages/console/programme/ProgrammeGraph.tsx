// Programme Graph V2 — focused, evidence-oriented Programme workspace.
//
// Default is one collision-safe 2-hop neighborhood, never the full programme.
// All-programme and weak refs are explicit. Cards remain neutral; semantic
// colour belongs primarily to relation classes and factual change state.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, type Edge, type Node } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type {
  ProgrammeChangeSet,
  ProgrammeEdge,
  ProgrammeEntityChange,
  ProgrammeGraph,
  ProgrammeNode,
  ProgrammeSnapshot,
} from "../../../../types/programme.ts";
import { useProgrammeDrawer } from "./programme-drawer.ts";
import { useProgrammeContext } from "./context-buffer.ts";
import { useProgrammeChangeStore } from "./useProgrammeChanges.ts";
import { displayIdOf } from "./identity.ts";
import "./programme.css";
import "./programme-v2.css";

const NODE_W = 268;
const NODE_H = 154;
const PAD = 32;

const KIND_LABEL: Record<string, string> = {
  workstream: "Workstream",
  assignment: "Assignment",
  decision: "ADR",
  actor: "Actor",
  collision: "ID collision",
  state: "State",
  journal: "Journal",
  publication: "Publication",
  research: "Research",
  proposal: "Proposal",
  repository: "Repository",
  jira: "Jira",
};

const DEFAULT_KINDS = new Set(Object.keys(KIND_LABEL));

type GraphMode = "current" | "changes";
type RefMode = "strong" | "all";
type ChangeKind = "added" | "removed" | "changed" | null;

interface VisualGraph extends ProgrammeGraph {
  changeKinds: Map<string, ChangeKind>;
  relationChanges: Map<string, "added" | "removed">;
}

interface FlowNodeData extends Record<string, unknown> {
  node: ProgrammeNode;
  focused: boolean;
  dimmed: boolean;
  changeKind: ChangeKind;
  relationCount: number;
}

interface FlowNode extends Node<FlowNodeData, "programme"> {}
interface FlowEdge extends Edge<{ edge: ProgrammeEdge; changeKind?: "added" | "removed" }> {}

interface FocusCtx {
  id: string;
  nodeIds: Set<string>;
}

function relationKey(edge: Pick<ProgrammeEdge, "source" | "target" | "relation" | "field">): string {
  return [edge.source, edge.target, edge.relation, edge.field].join("\u001f");
}

function changeKind(change: ProgrammeEntityChange, currentIds: Set<string>): ChangeKind {
  if (!currentIds.has(change.entity_key)) return "removed";
  const addedFields = change.field_changes.length > 0 && change.field_changes.every((field) => field.kind === "added");
  const firstObserved = change.status_trail.length <= 1 || !change.previous_revision_sha;
  return addedFields && firstObserved ? "added" : "changed";
}

function withChanges(graph: ProgrammeGraph, changeSet: ProgrammeChangeSet | null, mode: GraphMode): VisualGraph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const changeKinds = new Map<string, ChangeKind>();
  const relationChanges = new Map<string, "added" | "removed">();
  if (mode !== "changes" || !changeSet) return { ...graph, nodes, edges, changeKinds, relationChanges };

  const currentIds = new Set(nodes.map((node) => node.id));
  const edgeKeys = new Set(edges.map(relationKey));
  for (const change of changeSet.entities) {
    const kind = changeKind(change, currentIds);
    changeKinds.set(change.entity_key, kind);
    if (kind === "removed" && !currentIds.has(change.entity_key)) {
      nodes.push({
        id: change.entity_key,
        kind: change.kind,
        title: change.title || change.display_id,
        status: change.status_trail.at(-2)?.status ?? "REMOVED",
        source_path: change.path,
        metadata: { change_state: "removed" },
        metadata_tree: {},
      });
    }
    for (const relation of change.relation_changes) {
      const key = relationKey(relation);
      relationChanges.set(key, relation.kind);
      if (relation.kind === "removed" && !edgeKeys.has(key)) {
        edges.push({
          source: relation.source,
          target: relation.target,
          relation: relation.relation,
          field: relation.field,
          strength: relation.strength,
        });
        edgeKeys.add(key);
      }
    }
  }
  return { ...graph, nodes, edges, changeKinds, relationChanges };
}

function defaultFocusId(graph: ProgrammeGraph, changeSet?: ProgrammeChangeSet | null, changesMode = false): string | null {
  if (changesMode && changeSet?.entities.length) {
    const first = changeSet.entities.find((change) => graph.nodes.some((node) => node.id === change.entity_key));
    if (first) return first.entity_key;
  }
  if (graph.nodes.some((node) => node.id === "OPS-010")) return "OPS-010";
  const activeAssignment = graph.nodes.find((node) => node.kind === "assignment" && /ACTIVE|IN_PROGRESS|RUNNING|AUTHORIZED|READY/i.test(node.status ?? ""));
  if (activeAssignment) return activeAssignment.id;
  const active = graph.nodes.find((node) => /ACTIVE|IN_PROGRESS|RUNNING|AUTHORIZED/i.test(node.status ?? ""));
  return active?.id ?? graph.nodes[0]?.id ?? null;
}

function twoHopNeighborhood(graph: ProgrammeGraph, startId: string, kinds: Set<string>, refMode: RefMode): Set<string> {
  const result = new Set<string>([startId]);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let frontier = [startId];
  for (let hop = 0; hop < 2; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        if (refMode === "strong" && edge.strength === "weak" && edge.source !== startId && edge.target !== startId) continue;
        const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
        if (!other || result.has(other)) continue;
        const node = byId.get(other);
        if (node && kinds.has(node.kind)) {
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

function edgeTone(edge: ProgrammeEdge): "structure" | "authority" | "history" | "provenance" | "weak" {
  if (edge.strength === "weak") return "weak";
  const relation = edge.relation.toLowerCase();
  if (/(authoriz|assignment|owner|created_by|parent|projection|current_assignment)/.test(relation)) return "authority";
  if (/(state|journal|history|snapshot|materialize|paired_run)/.test(relation)) return "history";
  if (/(publication|published|repository|portfolio|dispatch|operator_input|jira)/.test(relation)) return "provenance";
  return "structure";
}

function edgeStyle(edge: ProgrammeEdge, change?: "added" | "removed") {
  const tone = edgeTone(edge);
  const stroke = tone === "authority" ? "var(--accent-blue)"
    : tone === "history" ? "var(--accent-green)"
      : tone === "provenance" ? "var(--accent-amber)"
        : "var(--border-strong, var(--border-subtle))";
  return {
    stroke,
    strokeWidth: change ? 2 : 1.25,
    opacity: change === "removed" ? 0.38 : tone === "weak" ? 0.45 : 0.8,
    strokeDasharray: change === "removed" ? "7 5" : tone === "weak" ? "4 5" : undefined,
  };
}

function buildFlow(
  graph: VisualGraph,
  kinds: Set<string>,
  refMode: RefMode,
  focus: FocusCtx | null,
  graphMode: GraphMode,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const visible = focus ? graph.nodes.filter((node) => focus.nodeIds.has(node.id)) : graph.nodes.filter((node) => kinds.has(node.kind));
  const ids = new Set(visible.map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) =>
    ids.has(edge.source)
    && ids.has(edge.target)
    && (refMode === "all" || edge.strength === "strong" || (focus && (edge.source === focus.id || edge.target === focus.id))),
  );

  const dagreGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 110, marginx: 0, marginy: 0 });
  for (const node of visible) dagreGraph.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of visibleEdges) if (edge.strength === "strong") dagreGraph.setEdge(edge.source, edge.target);
  dagre.layout(dagreGraph);

  let minX = Infinity;
  let minY = Infinity;
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of visible) {
    const position = dagreGraph.node(node.id);
    if (!position) continue;
    const x = position.x - NODE_W / 2;
    const y = position.y - NODE_H / 2;
    positions.set(node.id, { x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
  const offsetX = -minX + PAD;
  const offsetY = -minY + PAD;

  const relationCounts = new Map<string, number>();
  for (const edge of visibleEdges) {
    relationCounts.set(edge.source, (relationCounts.get(edge.source) ?? 0) + 1);
    relationCounts.set(edge.target, (relationCounts.get(edge.target) ?? 0) + 1);
  }

  const nodes: FlowNode[] = visible.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const kind = graph.changeKinds.get(node.id) ?? null;
    return {
      id: node.id,
      type: "programme",
      position: { x: position.x + offsetX, y: position.y + offsetY },
      data: {
        node,
        focused: focus?.id === node.id,
        dimmed: graphMode === "changes" && kind === null,
        changeKind: kind,
        relationCount: relationCounts.get(node.id) ?? 0,
      },
      draggable: false,
      selectable: false,
    };
  });

  const edges: FlowEdge[] = visibleEdges.map((edge, index) => {
    const change = graph.relationChanges.get(relationKey(edge));
    return {
      id: `${edge.source}::${edge.target}::${edge.relation}::${edge.field}::${index}`,
      source: edge.source,
      target: edge.target,
      label: focus ? edge.relation : undefined,
      type: "default",
      data: { edge, changeKind: change },
      style: edgeStyle(edge, change),
      labelStyle: { fontSize: 9, fill: "var(--text-muted)" },
      labelBgStyle: { fill: "var(--surface-primary)" },
      labelBgPadding: [3, 2] as [number, number],
      labelBgBorderRadius: 3,
      zIndex: change ? 2 : 1,
    };
  });

  return { nodes, edges };
}

function metadataValue(node: ProgrammeNode, keys: string[]): string | null {
  const root = node.metadata ?? {};
  const queue: Record<string, unknown>[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const key of keys) {
      const value = current[key];
      if (value !== undefined && value !== null && value !== "" && typeof value !== "object") return String(value);
    }
    for (const value of Object.values(current)) if (value && typeof value === "object" && !Array.isArray(value)) queue.push(value as Record<string, unknown>);
  }
  return null;
}

function ProgrammeNodeView({ data }: { data: FlowNodeData }) {
  const node = data.node;
  const rows = [
    ["owner", metadataValue(node, ["owner", "actor_id", "assigned_role"])],
    ["scope", metadataValue(node, ["workstream", "assignment_id", "target_repository", "source_repository"])],
    ["source", node.source_path ?? null],
  ].filter((row): row is [string, string] => Boolean(row[1])).slice(0, 3);
  const className = [
    "pg2-card",
    data.focused ? "is-focused" : "",
    data.dimmed ? "is-dimmed" : "",
    data.changeKind ? `is-${data.changeKind}` : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={className} style={{ width: NODE_W, height: NODE_H }} data-entity-key={node.id}>
      <div className="pg2-card-head">
        <span className="pg2-kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
        {data.changeKind ? <span className={`pg2-change pg2-change-${data.changeKind}`}>{data.changeKind === "added" ? "+" : data.changeKind === "removed" ? "−" : "Δ"}</span> : null}
      </div>
      <div className="pg2-card-id">{displayIdOf(node)}</div>
      <div className="pg2-card-title" title={node.title}>{node.title}</div>
      <div className="pg2-card-meta">
        {rows.map(([label, value]) => <div key={label} className="pg2-meta-row"><span>{label}</span><b>{value}</b></div>)}
      </div>
      <div className="pg2-card-foot">
        {node.status ? <span className="pg2-chip">{node.status}</span> : null}
        <span className="pg2-chip">{data.relationCount} rel</span>
        {node.kind === "collision" ? <span className="pg2-chip">ambiguous</span> : null}
      </div>
    </div>
  );
}

function shortestPath(graph: ProgrammeGraph, start: string, end: string, refMode: RefMode): { nodes: string[]; edges: ProgrammeEdge[] } | null {
  if (start === end) return { nodes: [start], edges: [] };
  const queue = [start];
  const seen = new Set([start]);
  const previous = new Map<string, { node: string; edge: ProgrammeEdge }>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (refMode === "strong" && edge.strength === "weak") continue;
      const other = edge.source === current ? edge.target : edge.target === current ? edge.source : null;
      if (!other || seen.has(other)) continue;
      seen.add(other);
      previous.set(other, { node: current, edge });
      if (other === end) {
        const nodes = [end];
        const edges: ProgrammeEdge[] = [];
        let cursor = end;
        while (cursor !== start) {
          const step = previous.get(cursor);
          if (!step) return null;
          edges.unshift(step.edge);
          nodes.unshift(step.node);
          cursor = step.node;
        }
        return { nodes, edges };
      }
      queue.push(other);
    }
  }
  return null;
}

function setEntityQuery(entityId: string | null) {
  try {
    const url = new URL(window.location.href);
    if (entityId) url.searchParams.set("entity", entityId); else url.searchParams.delete("entity");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // navigation hint only
  }
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
  const storedChangeSet = useProgrammeChangeStore((state) => state.changeSet);
  const changeSet = storedChangeSet;
  const [graphMode, setGraphMode] = useState<GraphMode>("current");
  const [refMode, setRefMode] = useState<RefMode>("strong");
  const [kinds, setKinds] = useState<Set<string>>(new Set(DEFAULT_KINDS));
  const [allProgramme, setAllProgramme] = useState(false);
  const initialFromQuery = (() => {
    try { return new URLSearchParams(window.location.search).get("entity"); } catch { return null; }
  })();
  const [focusedId, setFocusedId] = useState<string | null>(() =>
    initialFromQuery && graph.nodes.some((node) => node.id === initialFromQuery)
      ? initialFromQuery
      : defaultFocusId(graph),
  );
  const [search, setSearch] = useState("");
  const [pathStartId, setPathStartId] = useState<string | null>(null);
  const open = useProgrammeDrawer((state) => state.open);
  const addNode = useProgrammeContext((state) => state.addNode);
  const addSelection = useProgrammeContext((state) => state.addSelection);

  const visualGraph = useMemo(() => withChanges(graph, changeSet, graphMode), [graph, changeSet, graphMode]);

  useEffect(() => {
    if (!focusedId || !visualGraph.nodes.some((node) => node.id === focusedId)) {
      const next = defaultFocusId(visualGraph, changeSet, graphMode === "changes");
      setFocusedId(next);
      setEntityQuery(next);
    }
  }, [visualGraph, focusedId, changeSet, graphMode]);

  const focusedNode = useMemo(
    () => (!allProgramme && focusedId ? visualGraph.nodes.find((node) => node.id === focusedId) ?? null : null),
    [visualGraph, focusedId, allProgramme],
  );
  const focusNodeIds = useMemo(
    () => focusedNode ? twoHopNeighborhood(visualGraph, focusedNode.id, kinds, refMode) : null,
    [visualGraph, focusedNode, kinds, refMode],
  );
  const flow = useMemo(
    () => buildFlow(visualGraph, kinds, refMode, focusedNode && focusNodeIds ? { id: focusedNode.id, nodeIds: focusNodeIds } : null, graphMode),
    [visualGraph, kinds, refMode, focusedNode, focusNodeIds, graphMode],
  );

  const focus = (id: string) => {
    setFocusedId(id);
    setAllProgramme(false);
    setEntityQuery(id);
  };

  const restoreFocus = () => {
    const next = focusedId && visualGraph.nodes.some((node) => node.id === focusedId)
      ? focusedId
      : defaultFocusId(visualGraph, changeSet, graphMode === "changes");
    setAllProgramme(false);
    setFocusedId(next);
    setEntityQuery(next);
  };

  const doSearch = () => {
    const query = search.trim().toLowerCase();
    if (!query) return;
    const match = visualGraph.nodes.find((node) => node.id.toLowerCase() === query)
      ?? visualGraph.nodes.find((node) => displayIdOf(node).toLowerCase() === query)
      ?? visualGraph.nodes.find((node) => node.id.toLowerCase().includes(query) || node.title.toLowerCase().includes(query));
    if (match) focus(match.id);
  };

  const currentFocusedNode = focusedNode && graph.nodes.find((node) => node.id === focusedNode.id) ?? null;
  const incident = currentFocusedNode
    ? graph.edges.filter((edge) => edge.source === currentFocusedNode.id || edge.target === currentFocusedNode.id)
    : [];
  const currentNeighborhood = focusNodeIds
    ? [...focusNodeIds].map((id) => graph.nodes.find((node) => node.id === id)).filter((node): node is ProgrammeNode => Boolean(node))
    : [];
  const neighborhoodEdges = focusNodeIds
    ? graph.edges.filter((edge) => focusNodeIds.has(edge.source) && focusNodeIds.has(edge.target) && (refMode === "all" || edge.strength === "strong"))
    : [];
  const path = pathStartId && currentFocusedNode && pathStartId !== currentFocusedNode.id
    ? shortestPath(graph, pathStartId, currentFocusedNode.id, refMode)
    : null;

  const graphChanges = changeSet?.entities.length ?? changesEntityKeys?.size ?? 0;

  return (
    <div className="pg-app pg2-fit">
      <div className="pg-toolbar pg2-toolbar">
        <div className="pg2-toolbar-main">
          <div className="pg2-mode" role="group" aria-label="Graph mode">
            <button type="button" className={graphMode === "current" ? "pg-filter is-active" : "pg-filter"} onClick={() => setGraphMode("current")}>Current</button>
            <button type="button" className={graphMode === "changes" ? "pg-filter is-active" : "pg-filter"} onClick={() => {
              setGraphMode("changes");
              const next = defaultFocusId(withChanges(graph, changeSet, "changes"), changeSet, true);
              if (next) focus(next);
            }}>Changes {graphChanges ? `· ${graphChanges}` : ""}</button>
          </div>
          <div className="pg2-mode" role="group" aria-label="View mode">
            <button type="button" className={!allProgramme ? "pg-filter is-active" : "pg-filter"} onClick={restoreFocus}>Focused 2-hop</button>
            <button type="button" className={allProgramme ? "pg-filter is-active" : "pg-filter"} onClick={() => { setAllProgramme(true); setEntityQuery(null); }}>All programme</button>
          </div>
          <div className="pg2-mode" role="group" aria-label="Reference mode">
            <button type="button" className={refMode === "strong" ? "pg-filter is-active" : "pg-filter"} onClick={() => setRefMode("strong")}>Structural</button>
            <button type="button" className={refMode === "all" ? "pg-filter is-active" : "pg-filter"} onClick={() => setRefMode("all")}>All refs</button>
          </div>
          <div className="pg2-search-wrap">
            <input className="pd-search pg2-search" placeholder="Find entity…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") doSearch(); }} />
            <button type="button" className="pg-filter" onClick={doSearch}>Focus</button>
          </div>
        </div>
        <div className="pg2-kind-filters">
          {Object.entries(KIND_LABEL).map(([kind, label]) => (
            <button key={kind} type="button" className={kinds.has(kind) ? "pg-filter is-active" : "pg-filter"} onClick={() => setKinds((current) => {
              const next = new Set(current);
              if (next.has(kind)) next.delete(kind); else next.add(kind);
              return next;
            })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {graph.identity_collisions.length > 0 ? (
        <div className="pg-banner pg2-collision-banner">
          <strong>Identity collision:</strong> {graph.identity_collisions.map((collision) => `${collision.id} ×${collision.records.length}`).join(" · ")}. Ambiguity is preserved; source records remain path-qualified.
        </div>
      ) : null}

      {focusedNode ? (
        <div className="pg2-ctxbar" data-testid="pg2-ctxbar">
          <div className="pg2-ctxbar-main">
            <span className="pg2-ctxbar-id">{displayIdOf(focusedNode)}</span>
            <span className="pg2-ctxbar-title">{focusedNode.title}</span>
            <span className="pg2-ctxbar-kind">{KIND_LABEL[focusedNode.kind] ?? focusedNode.kind}</span>
            {focusedNode.status ? <span className="pg2-chip">{focusedNode.status}</span> : null}
            <span className="pg2-chip">{flow.nodes.length} nodes · {flow.edges.length} relations</span>
          </div>
          <div className="pg2-ctxbar-actions">
            <button type="button" className="pg2-btn" onClick={() => open(focusedNode.id)}>Inspect</button>
            <button type="button" className="pg2-btn" disabled={!currentFocusedNode} onClick={() => {
              if (currentFocusedNode) addNode(snapshot, currentFocusedNode, { source_view: "graph", derivedRelations: incident });
            }}>Add object</button>
            <button type="button" className="pg2-btn" disabled={currentNeighborhood.length === 0} onClick={() => addSelection(snapshot, currentNeighborhood, {
              kind: "graph_neighborhood",
              label: `Neighborhood: ${displayIdOf(focusedNode)}`,
              source_view: "graph",
              selectedRelations: neighborhoodEdges.filter((edge) => edge.strength === "strong"),
              derivedRelations: neighborhoodEdges.filter((edge) => edge.strength === "weak"),
            })}>Add neighborhood</button>
            {!pathStartId ? (
              <button type="button" className="pg2-btn" disabled={!currentFocusedNode} onClick={() => currentFocusedNode && setPathStartId(currentFocusedNode.id)}>Start path</button>
            ) : pathStartId === focusedNode.id ? (
              <button type="button" className="pg2-btn" onClick={() => setPathStartId(null)}>Cancel path</button>
            ) : (
              <button type="button" className="pg2-btn" disabled={!path || !currentFocusedNode} onClick={() => {
                if (!path || !currentFocusedNode) return;
                const nodes = path.nodes.map((id) => graph.nodes.find((node) => node.id === id)).filter((node): node is ProgrammeNode => Boolean(node));
                addSelection(snapshot, nodes, {
                  kind: "graph_path",
                  label: `Path: ${pathStartId} → ${currentFocusedNode.id}`,
                  source_view: "graph",
                  selectedPath: path.nodes.join(" → "),
                  selectedRelations: path.edges,
                });
                setPathStartId(null);
              }}>Add path from {pathStartId}</button>
            )}
          </div>
        </div>
      ) : null}

      <div className="pg-stats pg2-stats">
        {allProgramme ? `${flow.nodes.length} visible nodes · ${flow.edges.length} visible relations` : "Focused 2-hop workspace"}
        {graphMode === "changes" ? " · unchanged entities dimmed; removed evidence shown as ghost records" : ""}
      </div>

      <div className="pg-pane pg2-pane">
        <ReactFlowProvider>
          <ReactFlow
            key={`${graphMode}:${refMode}:${allProgramme}:${focusedId ?? "none"}:${flow.nodes.length}:${flow.edges.length}`}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={{ programme: ProgrammeNodeView }}
            onNodeClick={(_, node) => focus((node.data as FlowNodeData).node.id)}
            onNodeDoubleClick={(_, node) => open((node.data as FlowNodeData).node.id)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            zoomOnScroll
            zoomOnPinch
            panOnScroll={false}
            panOnDrag
            preventScrolling
            fitView
            fitViewOptions={{ padding: 0.16 }}
            minZoom={0.12}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="var(--border-subtle)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
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
