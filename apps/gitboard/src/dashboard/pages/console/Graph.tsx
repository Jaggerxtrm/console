import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SyncIcon, ProjectIcon } from "@primer/octicons-react";
import { useShellStore, selectSelection } from "../../stores/shell.ts";
import { useGraphData } from "../../hooks/useGraphData.ts";
import { GraphSvg } from "./graph/GraphSvg.tsx";
import { layoutGraph } from "./graph/layout.ts";

export function Graph() {
  const selection = useShellStore(selectSelection);
  const projectId = selection.repo;
  const { loading, error, data } = useGraphData(projectId);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });

  const layout = useMemo(() => (data ? layoutGraph(data.nodes, data.edges) : null), [data]);
  const specialists = useMemo(() => new Set(data?.specialists.map((item) => item.bead_id) ?? []), [data]);

  useEffect(() => {
    const onReset = () => setTransform({ x: 0, y: 0, scale: 1 });
    window.addEventListener("graph-reset-view", onReset as EventListener);
    return () => window.removeEventListener("graph-reset-view", onReset as EventListener);
  }, []);

  if (typeof window === "undefined") return null;
  if (!projectId) return <EmptyState icon={<ProjectIcon size={12} />} title="No beads in this project" />;
  if (loading && !layout) return <Status>Loading graph…</Status>;
  if (error) return <Status>{error}</Status>;
  if (!layout || layout.nodes.length === 0) return <EmptyState icon={<ProjectIcon size={12} />} title="No beads in this project" />;

  const onNodeClick = (beadId: string) => console.log(beadId);
  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 });

  return (
    <div className="graph-shell">
      <div className="graph-toolbar">
        <button type="button" className="graph-reset-button" onClick={resetView} aria-label="Reset view"><SyncIcon size={12} /></button>
      </div>
      <svg
        className="graph-viewport"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onWheel={(event) => {
          event.preventDefault();
          const delta = event.deltaY > 0 ? 0.92 : 1.08;
          setTransform((curr) => ({ ...curr, scale: clamp(curr.scale * delta, 0.3, 3) }));
        }}
        onMouseDown={(event) => {
          const start = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
          const move = (ev: MouseEvent) => setTransform((curr) => ({ ...curr, x: start.tx + (ev.clientX - start.x), y: start.ty + (ev.clientY - start.y), scale: curr.scale }));
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      >
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          <GraphSvg nodes={layout.nodes} edges={layout.edges} specialists={specialists} onNodeClick={onNodeClick} />
        </g>
      </svg>
    </div>
  );
}

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className="graph-empty"><span className="graph-empty-icon">{icon}</span><div className="graph-empty-title">{title}</div></div>;
}

function Status({ children }: { children: ReactNode }) {
  return <div className="graph-status">{children}</div>;
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
