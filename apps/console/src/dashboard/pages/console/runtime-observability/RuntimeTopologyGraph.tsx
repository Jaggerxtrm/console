import dagre from "@dagrejs/dagre";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import type { RuntimeEntity, RuntimeObservabilityModel, RuntimeRelation } from "../../../../types/runtime-observability.ts";

interface RuntimeTopologyGraphProps {
  model: RuntimeObservabilityModel;
  selectedId: string | null;
  query: string;
  scope: "all" | "active" | "attention";
  onSelect: (id: string) => void;
}

export function RuntimeTopologyGraph({ model, selectedId, query, scope, onSelect }: RuntimeTopologyGraphProps) {
  const graph = useMemo(() => buildGraph(model, query, scope, selectedId), [model, query, scope, selectedId]);

  if (graph.nodes.length === 0) {
    return <div className="runtime-empty">No runtime entities match the current filter.</div>;
  }

  return (
    <div className="runtime-graph">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1.05 }}
        minZoom={0.24}
        maxZoom={1.45}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => onSelect(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--runtime-grid-dot)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <div className="runtime-graph-legend" aria-label="Graph relation legend">
        <span><i className="runtime-edge-key runtime-edge-key--contains" /> tmux structure</span>
        <span><i className="runtime-edge-key runtime-edge-key--dispatch" /> dispatch parent</span>
        <span><i className="runtime-edge-key runtime-edge-key--workflow" /> workflow only</span>
      </div>
    </div>
  );
}

function buildGraph(
  model: RuntimeObservabilityModel,
  query: string,
  scope: "all" | "active" | "attention",
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const directMatches = new Set(model.entities.filter((entity) => matchesEntity(entity, query, scope)).map((entity) => entity.id));
  const visibleIds = new Set(directMatches);

  for (const relation of model.relations) {
    if (directMatches.has(relation.source) || directMatches.has(relation.target)) {
      visibleIds.add(relation.source);
      visibleIds.add(relation.target);
    }
  }

  const visibleEntities = model.entities.filter((entity) => visibleIds.has(entity.id));
  const visibleRelations = model.relations.filter((relation) => visibleIds.has(relation.source) && visibleIds.has(relation.target));
  const nodes = visibleEntities.map((entity) => makeNode(entity, selectedId === entity.id));
  const edges = visibleRelations.map(makeEdge);
  return layout(nodes, edges);
}

function makeNode(entity: RuntimeEntity, selected: boolean): Node {
  const width = entity.kind === "session" ? 218 : entity.kind === "pane" ? 282 : 250;
  const height = entity.kind === "session" ? 72 : 116;
  return {
    id: entity.id,
    position: { x: 0, y: 0 },
    data: {
      label: <RuntimeNodeCard entity={entity} selected={selected} />,
    },
    style: {
      width,
      height,
      padding: 0,
      border: "none",
      background: "transparent",
      boxShadow: "none",
    },
    selectable: true,
  };
}

function RuntimeNodeCard({ entity, selected }: { entity: RuntimeEntity; selected: boolean }) {
  return (
    <div className={`runtime-node runtime-node--${entity.kind}${selected ? " is-selected" : ""}`}>
      <div className="runtime-node__topline">
        <span className={`runtime-state-dot runtime-state-dot--${entity.tone}`} />
        <span className="runtime-node__kind">{entity.kind}</span>
        <span className="runtime-node__state">{entity.state.replaceAll("_", " ")}</span>
      </div>
      <div className="runtime-node__title" title={entity.title}>{entity.title}</div>
      <div className="runtime-node__subtitle" title={entity.subtitle}>{entity.subtitle}</div>
      {entity.kind !== "session" ? (
        <div className="runtime-node__meta">
          {entity.beadId ? <span>{entity.beadId}</span> : null}
          {entity.runtime ? <span>{entity.runtime}</span> : null}
          {entity.specialistJob ? <span>sp:{entity.specialistJob.status}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function makeEdge(relation: RuntimeRelation): Edge {
  const isDispatch = relation.kind === "dispatch";
  return {
    id: relation.id,
    source: relation.source,
    target: relation.target,
    type: "smoothstep",
    animated: false,
    style: {
      stroke: isDispatch ? "var(--runtime-edge-dispatch)" : "var(--runtime-edge-muted)",
      strokeWidth: isDispatch ? 1.5 : 1,
      strokeDasharray: relation.kind === "correlated" ? "5 5" : undefined,
    },
  };
}

function layout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", ranksep: 82, nodesep: 30, marginx: 28, marginy: 28 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const width = Number(node.style?.width ?? 260);
    const height = Number(node.style?.height ?? 104);
    graph.setNode(node.id, { width, height });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const point = graph.node(node.id) as { x: number; y: number; width: number; height: number } | undefined;
      if (!point) return node;
      return {
        ...node,
        position: { x: point.x - point.width / 2, y: point.y - point.height / 2 },
      };
    }),
    edges,
  };
}

function matchesEntity(entity: RuntimeEntity, query: string, scope: "all" | "active" | "attention"): boolean {
  if (scope === "active" && entity.tone !== "active" && entity.tone !== "attention") return false;
  if (scope === "attention" && entity.tone !== "attention") return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    entity.title,
    entity.subtitle,
    entity.sessionName,
    entity.paneId,
    entity.instanceId,
    entity.beadId,
    entity.role,
    entity.runtime,
    entity.path,
    entity.branch,
    entity.chainId,
  ].some((value) => value?.toLowerCase().includes(needle));
}
