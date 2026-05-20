// Graph view — sparse-graph optimized layout per docs/graph reference.
//
// Top-down: header → NOW strip (running) → main grid (clusters | orphan sidebar) →
// state buckets (inline <details>) → keyboard shortcut foot.
// No heavy enclosure chrome: each cluster is a subtle bg + 1px border + 6px radius.
// Nodes are HTML divs (200×26) positioned absolutely inside the cluster canvas; SVG
// renders edges only.

import { useMemo, useState, type ReactNode } from "react";
import { ProjectIcon } from "@primer/octicons-react";
import { useShellStore, selectSelection } from "../../stores/shell.ts";
import { useGraphData } from "../../hooks/useGraphData.ts";
import { layoutGraph, type LayoutEdge, type LayoutNode } from "./graph/layout.ts";
import { computeNodeWidth } from "./graph/GraphSvg.tsx";
import { partitionGraph, type ClusterGroup, type BucketGroup } from "./graph/clusters.ts";
import { categoryFor, shortJobId, type AgentCategory } from "./graph/agent-roles.ts";
import { EDGE_STYLE_VARS } from "./graph/edge-styles.ts";
import type { GraphNode, GraphSpecialist } from "../../../types/graph.ts";

export function Graph() {
  const selection = useShellStore(selectSelection);
  const projectId = selection.repo ? selection.repo.split("/").pop() ?? null : null;
  const { loading, error, data } = useGraphData(projectId);
  const [showParent, setShowParent] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
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
  if (!partition || (partition.clusters.length === 0 && partition.orphans.length === 0 && partition.wip.length === 0)) {
    return <EmptyState icon={<ProjectIcon size={12} />} title="No beads in this project" />;
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
        <span className="g-sub">─ organized layout · sparse-graph optimized</span>
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

      {partition.wip.length > 0 ? <NowStrip nodes={partition.wip} specialists={specialistByBead} /> : null}

      <div className="g-main">
        <div className="g-clusters">
          {renderClusterFlow(partition.clusters, specialistByBead)}
        </div>
        {partition.orphans.length > 0 ? <OrphanSidebar nodes={partition.orphans} /> : null}
      </div>

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
// NOW strip (pinned WIP)
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

// ============================================================================
// Clusters flow — big cluster full width, small (≤3) cluster pair two-per-row
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
  const nodeWidths = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of cluster.nodes) map.set(n.id, computeNodeWidth(n, specialists.get(n.id) ?? null));
    return map;
  }, [cluster, specialists]);

  const layout = useMemo(() => layoutGraph(cluster.nodes, cluster.edges, nodeWidths), [cluster, nodeWidths]);

  // Sub-header context (epic glyph if name leads with an id that's an epic).
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
      <div className="g-cluster-canvas" style={{ height: layout.height }}>
        <svg className="g-cluster-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMinYMin meet">
          <Edges edges={layout.edges} />
        </svg>
        {layout.nodes.map((n) => (
          <ClusterNode key={n.id} node={n} specialist={specialists.get(n.id) ?? null} width={nodeWidths.get(n.id) ?? 200} />
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Edges (SVG only)
// ============================================================================

function Edges({ edges }: { edges: LayoutEdge[] }) {
  return (
    <>
      <defs>
        {(["blocks", "supersedes", "discovered-from", "validates", "caused-by", "tracks", "until"] as const).map((type) => (
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
      {edges.map((edge) => {
        const style = EDGE_STYLE_VARS[edge.type];
        const [p0, p1, p2, p3] = edge.points;
        const d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
        const arrow = edge.type === "related" ? undefined : `url(#g-arrow-${edge.type})`;
        const mx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
        const my = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
        return (
          <g key={`${edge.from}->${edge.to}:${edge.type}`} className={`g-edge edge-${edge.type}`}>
            <path d={d} fill="none" stroke={style.token} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" markerEnd={arrow} />
            <text x={mx} y={my - 4} className={`g-elabel ${edgeLabelClass(edge.type)}`} textAnchor="middle">
              {edge.type === "parent-child" ? "parent" : edge.type}
            </text>
          </g>
        );
      })}
    </>
  );
}

function edgeLabelClass(type: string): string {
  return ({
    blocks: "blocks",
    "caused-by": "caused",
    validates: "validates",
    supersedes: "supersedes",
    "discovered-from": "discovered",
    tracks: "tracks",
    until: "until",
    "parent-child": "parent",
    related: "related",
  } as Record<string, string>)[type] ?? type;
}

// ============================================================================
// Cluster node — HTML div, absolutely positioned inside .g-cluster-canvas
// ============================================================================

function ClusterNode({ node, specialist, width }: { node: LayoutNode; specialist: GraphSpecialist | null; width: number }) {
  const isRunning = specialist?.status === "running";
  const isBlocked = node.status === "blocked";
  const isEpic = node.type === "epic";
  const agentCat: AgentCategory = categoryFor(specialist?.role);
  const classes = [
    "g-node",
    isBlocked ? "blkd" : "",
    isRunning ? "act" : "",
    isEpic ? "ep" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      data-p={node.priority}
      style={{ left: node.x, top: node.y, width }}
    >
      <span className={`g-glyph ${glyphClass(node)}`}>{glyphChar(node)}</span>
      <span className="g-id">
        {idPrefix(node.id)}<b>{idSuffix(node.id)}</b>
      </span>
      <span className="g-tt">{node.title}</span>
      {specialist ? (
        <span className={`g-ag ${agentCat}`}>
          <span className="g-ag-dot" />
          <b>{specialist.role}</b>/{shortJobId(specialist.job_id)}
        </span>
      ) : null}
      <span className={`g-tag p${node.priority}`}>P{node.priority}</span>
    </div>
  );
}

// ============================================================================
// Compact node-chip (used in NOW strip + orphan sidebar)
// ============================================================================

function NodeChip({ node, specialist, wide }: { node: GraphNode; specialist: GraphSpecialist | null; wide?: boolean }) {
  const isRunning = specialist?.status === "running";
  const isEpic = node.type === "epic";
  const agentCat: AgentCategory = categoryFor(specialist?.role);
  const classes = [
    "g-node",
    "g-node-inline",
    wide ? "g-node-wide" : "",
    isRunning ? "act" : "",
    node.status === "blocked" ? "blkd" : "",
    isEpic ? "ep" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} data-p={node.priority}>
      <span className={`g-glyph ${glyphClass(node)}`}>{glyphChar(node)}</span>
      <span className="g-id">{idPrefix(node.id)}<b>{idSuffix(node.id)}</b></span>
      <span className="g-tt">{node.title}</span>
      {specialist ? (
        <span className={`g-ag ${agentCat}`}>
          <span className="g-ag-dot" />
          <b>{specialist.role}</b>/{shortJobId(specialist.job_id)}
        </span>
      ) : null}
      <span className={`g-tag p${node.priority}`}>P{node.priority}</span>
    </div>
  );
}

// ============================================================================
// Orphan sidebar
// ============================================================================

function OrphanSidebar({ nodes }: { nodes: GraphNode[] }) {
  const visibleLimit = 18;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? nodes : nodes.slice(0, visibleLimit);
  const hidden = nodes.length - visible.length;
  return (
    <aside className="g-orphans">
      <div className="g-orphans-hd">
        <span className="g-orphans-ttl">orphans</span>
        <span className="g-spacer" />
        <em>{nodes.length} · no edges</em>
      </div>
      <div className="g-orphans-list">
        {visible.map((n) => <OrphanRow key={n.id} node={n} />)}
        {hidden > 0 ? (
          <div className="g-orphans-more" onClick={() => setExpanded(true)}>
            <b>+{hidden}</b> more orphans · expand
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function OrphanRow({ node }: { node: GraphNode }) {
  return (
    <div className="g-orow" data-p={node.priority} title={node.title}>
      <span className={`g-glyph ${glyphClass(node)}`}>{glyphChar(node)}</span>
      <span className="g-id">{idPrefix(node.id)}<b>{idSuffix(node.id)}</b></span>
      <span className="g-tt">{node.title}</span>
      <span className={`g-tag p${node.priority}`}>P{node.priority}</span>
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
// Foot — keyboard hints + toggle buttons
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

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className="g-empty"><span>{icon}</span><div>{title}</div></div>;
}
function Status({ children }: { children: ReactNode }) {
  return <div className="g-status">{children}</div>;
}
function glyphChar(node: { status: string; type: string; superseded_by: string | null }): string {
  if (node.superseded_by) return "✕";
  if (node.type === "epic") return "◈";
  return ({ open: "◯", in_progress: "◐", blocked: "◇", closed: "✓", deferred: "◇" } as Record<string, string>)[node.status] ?? "◯";
}
function glyphClass(node: { status: string; type: string; superseded_by: string | null }): string {
  if (node.superseded_by) return "c";
  if (node.type === "epic") return "e";
  return ({ open: "r", in_progress: "w", blocked: "b", closed: "c", deferred: "gt" } as Record<string, string>)[node.status] ?? "r";
}
function idPrefix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(0, i + 1) : ""; }
function idSuffix(id: string): string { const i = id.lastIndexOf("-"); return i > 0 ? id.slice(i + 1) : id; }
