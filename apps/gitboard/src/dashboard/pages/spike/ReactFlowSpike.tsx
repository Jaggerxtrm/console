// SPIKE (forge-2a8a.1) — throwaway. Deleted in forge-2a8a.4 cleanup.
// Proves: React Flow can host one cluster from partitionGraph using a custom
// node component that matches the current .g-node chip. Auto-layout via dagre.
// Visit /gitboard/spike/reactflow on a repo to render.

import { useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";

import { useGraphData } from "../../hooks/useGraphData.ts";
import { partitionGraph } from "../console/graph/clusters.ts";
import type { GraphSpecialist } from "../../../types/graph.ts";
import { BeadNode, type BeadNodeData } from "./BeadNode.tsx";

const NODE_W = 220;
const NODE_H = 26;
const NODE_TYPES = { beadNode: BeadNode };
const EMPTY_SPECIALISTS = new Map<string, GraphSpecialist>();

function pickProject(): string {
  if (typeof window === "undefined") return "gitboard";
  const params = new URLSearchParams(window.location.search);
  return params.get("project") ?? "gitboard";
}

export function ReactFlowSpike() {
  const [projectId] = useState<string>(pickProject);
  const { loading, error, data } = useGraphData(projectId);

  const partition = useMemo(() => {
    if (!data) return null;
    return partitionGraph(data, EMPTY_SPECIALISTS, {
      includeParentChild: false,
      includeRelated: false,
    });
  }, [data]);

  const cluster = partition?.clusters[0] ?? null;

  const flow = useMemo(() => {
    if (!cluster) return { nodes: [] as Node<BeadNodeData>[], edges: [] as Edge[] };
    // Dagre LR layout
    const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "LR", nodesep: 12, ranksep: 110 });
    for (const n of cluster.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    for (const e of cluster.edges) {
      if (e.type !== "blocks") continue;
      g.setEdge(e.from, e.to);
    }
    dagre.layout(g);

    const nodes: Node<BeadNodeData>[] = cluster.nodes.map((n) => {
      const pos = g.node(n.id);
      return {
        id: n.id,
        type: "beadNode",
        position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
        data: { node: n },
      };
    });
    const edges: Edge[] = cluster.edges.map((e, i) => ({
      id: `${e.from}::${e.to}::${e.type}::${i}`,
      source: e.from,
      target: e.to,
      label: e.type,
      style: { stroke: "var(--graph-edge-blocks, #666)", strokeWidth: 1.5 },
    }));
    return { nodes, edges };
  }, [cluster]);

  if (loading) return <div style={{ padding: 24 }}>Loading {projectId}…</div>;
  if (error) return <div style={{ padding: 24 }}>Error: {error}</div>;
  if (!cluster) return <div style={{ padding: 24 }}>No clusters in {projectId}. Try ?project=specialists</div>;

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#181818" }}>
      <div style={{ padding: "8px 12px", color: "#aaa", fontFamily: "Inter", fontSize: 12, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        spike · {projectId} · cluster: <b style={{ color: "#8ed2dc" }}>{cluster.name}</b> · {cluster.edges.length} edges
      </div>
      <div style={{ width: "100%", height: "calc(100vh - 33px)" }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#222" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
