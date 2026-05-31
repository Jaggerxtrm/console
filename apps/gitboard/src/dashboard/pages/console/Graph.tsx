// Graph view — per-cluster React Flow viewports inside a CSS-grid outer shell.
// Each cluster owns its own bounded pane with its own ReactFlow instance; pan/
// zoom is per-pane. Inter-cluster edges aren't a thing (clusters are connected
// components by definition), so each viewport is self-contained.
//
// Outer layout (top→bottom):
//   header (toggles)
//   NOW strip — HTML, running specialists
//   .g-clusters — CSS grid of <ClusterPane> (with g-clusters-row for small pairs)
//   orphans strip — bottom HTML row
//   Buckets row — <details> blocks
//   Foot — keyboard hints

import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { ProjectIcon } from "@primer/octicons-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useShellStore, selectRepos, selectSelection } from "../../stores/shell.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import { useGraphData } from "../../hooks/useGraphData.ts";
import { partitionGraph, type BucketGroup, type ClusterGroup } from "./graph/clusters.ts";
import { categoryFor, shortJobId, type AgentCategory } from "./graph/agent-roles.ts";
import { buildClusterFlow } from "./graph/buildFlowGraph.ts";
import { BeadNode } from "./graph/nodes/BeadNode.tsx";
import { CustomEdge } from "./graph/edges/CustomEdge.tsx";
import { EdgeMarkers } from "./graph/edges/EdgeMarkers.tsx";
import { TYPE_CONFIG } from "../../lib/type-palette.ts";
import type { GraphNode, GraphSpecialist } from "../../../types/graph.ts";

const NODE_TYPES = { beadNode: BeadNode };
const EDGE_TYPES = { custom: CustomEdge };

export function Graph() {
  const selection = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const selectedRepo = selection.repo ? repos.find((repo) => repo.fullName === selection.repo) : null;
  const projectId = selectedRepo?.beadsProjectId ?? null;
  const { loading, error, data, reload } = useGraphData(projectId);
  const [showParent, setShowParent] = useState(true);
  const [showRelated, setShowRelated] = useState(true);
  const [revealDeferred, setRevealDeferred] = useState(false);

  const specialistByBead = useMemo(() => {
    const map = new Map<string, GraphSpecialist>();
    for (const spec of data?.specialists ?? []) {
      const existing = map.get(spec.bead_id);
      if (!existing || spec.updated_at > existing.updated_at) map.set(spec.bead_id, spec);
    }
    return map;
  }, [data]);

  const partition = useMemo(() => {
    if (!data) return null;
    return partitionGraph(data, specialistByBead, {
      includeParentChild: showParent,
      includeRelated: showRelated,
      revealDeferred,
    });
  }, [data, specialistByBead, showParent, showRelated, revealDeferred]);

  if (typeof window === "undefined") return null;
  if (!projectId) return <EmptyState icon={<ProjectIcon size={12} />} title="No beads in this project" />;
  if (loading && !partition) return <Status>Loading graph…</Status>;
  if (error) return <Status>{error}</Status>;

  const freshness = data?.freshness ?? "stale";
  const isEmpty = !partition || (partition.clusters.length === 0 && partition.orphans.length === 0 && partition.wip.length === 0);
  if (isEmpty) {
    if (freshness === "fresh") return <EmptyState icon={<ProjectIcon size={12} />} title="No beads in this project" />;
    if (freshness === "degraded") return <EmptyState icon={<ProjectIcon size={12} />} title={data?.source_health?.message ?? "Graph data unavailable — last refresh failed"} action={<button type="button" className="g-empty-btn" onClick={() => void reload({ refresh: true, force: true })}>Retry</button>} />;
    return <Status>Loading project graph… Background refresh in progress.</Status>;
  }

  const runningCount = [...specialistByBead.values()].filter((s) => s.status === "running").length;
  const orphanCount = partition.orphans.length;
  const bucketTotal = partition.buckets.closed.length + partition.buckets.superseded.length + partition.buckets.deferred.length;

  return (
    <div className="g-app">
      <header className="g-hd">
        <span className="g-path">
          <b>{projectId}</b><span className="g-path-sl">/</span><b>graph</b>
        </span>
        <span className="g-sub">─ react flow · per-cluster panes</span>
        <span className="g-spacer" />
        <span className="g-cnt">
          <b>{data?.nodes.length ?? 0}</b> nodes · <b>{data?.edges.length ?? 0}</b> edges · <b>{runningCount}</b> running
          <em> · {partition.clusters.length} clusters · {orphanCount} orphans · {bucketTotal} hidden</em>
        </span>
        <span className="g-hd-toggles">
          <HeaderToggle on={showParent} onClick={() => setShowParent((v) => !v)} dotClass="edge-parent-child" label="parent-child" hint="p" />
          <HeaderToggle on={showRelated} onClick={() => setShowRelated((v) => !v)} dotClass="edge-related" label="related" hint="r" />
          <HeaderToggle on={revealDeferred} onClick={() => setRevealDeferred((v) => !v)} dotClass="state-deferred" label="deferred" hint="d" />
        </span>
      </header>

      {data?.source_health?.status === "degraded" ? (
        <div className="g-source-banner" role="status">
          {data.source_health.message ?? "Graph source degraded"}
        </div>
      ) : null}

      {partition.wip.length > 0 ? <NowStrip nodes={partition.wip} specialists={specialistByBead} /> : null}

      <div className="g-clusters">
        <EdgeMarkers />
        {renderClusterFlow(partition.clusters, specialistByBead)}
      </div>

      {partition.orphans.length > 0 ? <OrphanStrip nodes={partition.orphans} /> : null}

      {bucketTotal > 0 ? <BucketsRow buckets={partition.buckets} /> : null}

      <Foot />
    </div>
  );
}

function HeaderToggle({ on, onClick, dotClass, label, hint }: { on: boolean; onClick: () => void; dotClass: string; label: string; hint: string }) {
  return (
    <button type="button" className={`g-hd-tog${on ? " is-on" : ""}`} onClick={onClick} title={`[${hint}] toggle ${label}`}>
      <span className={`g-hd-tog-dot ${dotClass}`} />
      <span className="g-hd-tog-label">{label}</span>
      <span className="g-hd-tog-state">{on ? "on" : "off"}</span>
    </button>
  );
}

// ============================================================================
// Cluster flow — pack ≤3-node clusters two-per-row, full-width for the rest
// ============================================================================

function renderClusterFlow(clusters: ClusterGroup[], specialists: Map<string, GraphSpecialist>): ReactNode[] {
  const rows: ReactNode[] = [];
  const queue = [...clusters];
  while (queue.length) {
    const first = queue.shift()!;
    if (first.nodes.length <= 3) {
      const second = queue[0];
      if (second && second.nodes.length <= 3) {
        queue.shift();
        rows.push(
          <div className="g-clusters-row" key={rows.length}>
            <ClusterPane cluster={first} specialists={specialists} />
            <ClusterPane cluster={second} specialists={specialists} />
          </div>,
        );
        continue;
      }
    }
    rows.push(<ClusterPane cluster={first} specialists={specialists} key={rows.length} />);
  }
  return rows;
}

function ClusterPane({ cluster, specialists }: { cluster: ClusterGroup; specialists: Map<string, GraphSpecialist> }) {
  const flow = useMemo(() => buildClusterFlow(cluster, specialists), [cluster, specialists]);
  // Pane height tracks dagre's natural layout so the whole graph fits without
  // an internal scrollbar. Only a floor (120) for tiny clusters; the page-level
  // .g-app scroll handles overflow when many clusters stack.
  const paneHeight = Math.max(flow.height + 24, 120);
  // Key on the cluster's shape so toggling parent-child / related (which changes
  // edge count + dagre layout) remounts the ReactFlow and runs `fitView` again
  // — otherwise the camera keeps the previous transform and content clips.
  const flowKey = `${cluster.id}:${flow.nodes.length}:${flow.edges.length}`;

  const leadingId = cluster.name.split(/[\s·]/)[0];
  const epicNode = cluster.nodes.find((n) => n.id === leadingId && n.type === "epic");

  return (
    <section className="g-cluster">
      <div className="g-cluster-hd">
        <span className="g-cluster-ttl">
          {epicNode ? <span className="g-cluster-ep">◈</span> : null}
          {cluster.name}
        </span>
        <span className="g-cluster-sep">·</span>
        <em className="g-cluster-meta">
          {cluster.hasP0 ? <span className="g-cluster-tag p0">P0</span> : null}
          {cluster.hasRunning ? <span className="g-cluster-tag run">running</span> : null}
          {cluster.edges.length} edges
        </em>
      </div>
      <div className="g-pane" style={{ height: paneHeight }}>
        <ReactFlowProvider>
          <ReactFlow
            key={flowKey}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
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
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="var(--border-subtle)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </section>
  );
}

// ============================================================================
// NOW strip + Orphan strip (HTML)
// ============================================================================

function NowStrip({ nodes, specialists }: { nodes: GraphNode[]; specialists: Map<string, GraphSpecialist> }) {
  const runningNow = nodes.filter((n) => specialists.get(n.id)?.status === "running");
  const count = runningNow.length || nodes.length;
  return (
    <section className="g-now">
      <div className="g-now-lbl">
        <span className="g-glyph w">◐</span> now · {count} running
      </div>
      <div className="g-now-rows">
        {nodes.map((n) => (
          <NodeChip key={n.id} node={n} specialist={specialists.get(n.id) ?? null} wide />
        ))}
      </div>
    </section>
  );
}

function OrphanStrip({ nodes }: { nodes: GraphNode[] }) {
  const visibleLimit = 18;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? nodes : nodes.slice(0, visibleLimit);
  const hidden = nodes.length - visible.length;
  return (
    <section className="g-orphans-strip">
      <div className="g-orphans-hd">
        <span className="g-orphans-ttl">orphans</span>
        <em>{nodes.length} · no edges</em>
      </div>
      <div className="g-orphans-grid">
        {visible.map((n) => <OrphanRow key={n.id} node={n} />)}
        {hidden > 0 ? (
          <div className="g-orphans-more" onClick={() => setExpanded(true)}>
            <b>+{hidden}</b> more orphans · expand
          </div>
        ) : null}
      </div>
    </section>
  );
}

const TYPE_COLOR: Record<string, string> = {
  bug: TYPE_CONFIG.bug.color,
  feature: TYPE_CONFIG.feature.color,
  task: TYPE_CONFIG.task.color,
  epic: TYPE_CONFIG.epic.color,
  chore: TYPE_CONFIG.chore.color,
  decision: "var(--text-muted)",
  molecule: "var(--text-muted)",
};
const TYPE_LABEL: Record<string, string> = {
  bug: TYPE_CONFIG.bug.label.toLowerCase(), feature: TYPE_CONFIG.feature.label.toLowerCase(), task: TYPE_CONFIG.task.label.toLowerCase(), epic: TYPE_CONFIG.epic.label.toLowerCase(), chore: TYPE_CONFIG.chore.label.toLowerCase(), decision: "decision", molecule: "mol",
};
const STATUS_TEXT: Record<string, string> = {
  open: "open", in_progress: "in progress", blocked: "blocked", closed: "closed", deferred: "deferred",
};

function NodeChip({ node, specialist, wide }: { node: GraphNode; specialist: GraphSpecialist | null; wide?: boolean }) {
  const openSidebar = useShellStore((state) => state.openSidebar);
  const isRunning = specialist?.status === "running";
  const typeColor = TYPE_COLOR[node.type] ?? "var(--text-muted)";
  const typeLabel = TYPE_LABEL[node.type] ?? node.type;
  const statusLabel = node.superseded_by ? "superseded" : STATUS_TEXT[node.status] ?? node.status;
  const agentCat: AgentCategory = categoryFor(specialist?.role);
  const classes = ["g-node", "g-node-inline", wide ? "g-node-wide" : "", isRunning ? "act" : ""].filter(Boolean).join(" ");
  const handleClick = () => {
    if (!specialist) return;
    logClientEvent("chip.click", { source: "graph_node", beadId: node.id, jobId: specialist.job_id ?? null });
    openSidebar({ beadId: node.id, jobId: specialist.job_id ?? undefined });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleClick();
    }
  };
  return (
    <div className={classes} data-p={node.priority} onClick={handleClick} onKeyDown={handleKeyDown} role="button" tabIndex={0}>
      <div className="g-node-identity">
        <span className="g-id">{node.id}</span>
        <span className="g-sep">/</span>
        <span className="g-tt">{node.title}</span>
      </div>
      <div className="g-node-class">
        <span className="g-pri" style={{ color: typeColor }}>P{node.priority}</span>
        <span className="g-type" style={{ color: typeColor }}>{typeLabel}</span>
        <span className="g-state">{statusLabel}</span>
        {specialist ? (
          <>
            <span className="g-sep">·</span>
            <span className={`g-ag ${agentCat}`}>
              <span className="g-ag-dot" />
              <b>{specialist.role}</b>/{shortJobId(specialist.job_id)}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function OrphanRow({ node }: { node: GraphNode }) {
  const typeColor = TYPE_COLOR[node.type] ?? "var(--text-muted)";
  const typeLabel = TYPE_LABEL[node.type] ?? node.type;
  const statusLabel = node.superseded_by ? "superseded" : STATUS_TEXT[node.status] ?? node.status;
  return (
    <div className="g-orow" data-p={node.priority} title={node.title}>
      <div className="g-node-identity">
        <span className="g-id">{node.id}</span>
        <span className="g-sep">/</span>
        <span className="g-tt">{node.title}</span>
      </div>
      <div className="g-node-class">
        <span className="g-pri" style={{ color: typeColor }}>P{node.priority}</span>
        <span className="g-type" style={{ color: typeColor }}>{typeLabel}</span>
        <span className="g-state">{statusLabel}</span>
      </div>
    </div>
  );
}

// ============================================================================
// Buckets row — inline <details>
// ============================================================================

function BucketsRow({ buckets }: { buckets: BucketGroup }) {
  return (
    <div className="g-buckets">
      {buckets.deferred.length > 0 ? (
        <BucketDetails glyph="◇" name="deferred" count={buckets.deferred.length} nodes={buckets.deferred} />
      ) : null}
      {buckets.closed.length > 0 ? (
        <BucketDetails glyph="✓" name="closed" count={buckets.closed.length} nodes={buckets.closed} />
      ) : null}
      {buckets.superseded.length > 0 ? (
        <BucketDetails glyph="✕" name="superseded" count={buckets.superseded.length} nodes={buckets.superseded} />
      ) : null}
    </div>
  );
}

function BucketDetails({ glyph, name, count, nodes }: { glyph: string; name: string; count: number; nodes: GraphNode[] }) {
  return (
    <details className="g-bucket">
      <summary>
        <span className="g-bucket-chev">▶</span>
        <span className="g-glyph">{glyph}</span>
        <span className="g-bucket-ttl">{name}</span>
        <em>{count}</em>
      </summary>
      <div className="g-bucket-list">
        {nodes.slice(0, 50).map((n) => <OrphanRow key={n.id} node={n} />)}
        {nodes.length > 50 ? <div className="g-orphans-more"><b>+{nodes.length - 50}</b> more · expand</div> : null}
      </div>
    </details>
  );
}

// ============================================================================
// Foot — keyboard hints
// ============================================================================

function Foot() {
  return (
    <footer className="g-foot">
      <span>clusters sorted by <b>connectedness desc</b></span>
      <span>orphans sorted by <b>priority,age</b></span>
      <span className="g-spacer" />
      <span><kbd>p</kbd> parent-child · <kbd>r</kbd> related · <kbd>d</kbd> deferred</span>
    </footer>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function EmptyState({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return <div className="g-empty"><span>{icon}</span><div>{title}</div>{action ? <div>{action}</div> : null}</div>;
}
function Status({ children }: { children: ReactNode }) {
  return <div className="g-status">{children}</div>;
}
