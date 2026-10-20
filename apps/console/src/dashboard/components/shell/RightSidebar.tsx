import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { XIcon } from "@primer/octicons-react";
import { BeadActivityPane } from "../specialists/BeadActivityPane.tsx";
import { selectSidebar, useShellStore } from "../../stores/shell.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import type { RuntimeInspectorSnapshot } from "../../../types/runtime-observability.ts";

const EDGE_HIT_AREA_PX = 8;

export function RightSidebar() {
  const sidebar = useShellStore(selectSidebar);
  const closeSidebar = useShellStore((s) => s.closeSidebar);
  const setSidebarWidth = useShellStore((s) => s.setSidebarWidth);
  const dragCleanupRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    if (!sidebar.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebar("escape");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSidebar, sidebar.open]);

  if (!sidebar.open || (!sidebar.beadId && !sidebar.runtime)) return null;
  const runtime = sidebar.runtime;
  const beadId = sidebar.beadId;
  const title = runtime?.entity.title ?? beadId ?? "Inspector";
  const subtitle = runtime ? runtime.entity.subtitle : sidebar.jobId;

  return (
    <>
      <div className="right-sidebar-scrim" onClick={() => closeSidebar("click_out")} />
      <aside className="right-sidebar" aria-label={runtime ? "Runtime inspector" : "Bead details"} style={{ width: sidebar.width }}>
        <div className="right-sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" style={{ width: EDGE_HIT_AREA_PX, touchAction: "none" }} onPointerDown={(event) => startResize(event, setSidebarWidth, dragCleanupRef)} />
        <header className="right-sidebar-header">
          <div className="right-sidebar-title-group">
            <div className="right-sidebar-eyebrow">{runtime ? `Runtime ${runtime.entity.kind}` : "Activity inspector"}</div>
            <div className="right-sidebar-title">{title}</div>
            {subtitle ? <div className="right-sidebar-subtitle">{subtitle}</div> : null}
          </div>
          <button type="button" className="right-sidebar-close" aria-label="Close sidebar" onClick={() => closeSidebar("x_button")}>
            <XIcon size={16} />
          </button>
        </header>
        <div className="right-sidebar-body">
          {runtime ? <RuntimeInspectorBody snapshot={runtime} /> : beadId ? <BeadActivityPane key={beadId} beadId={beadId} jobIdHint={sidebar.jobId} /> : null}
        </div>
      </aside>
    </>
  );
}

function RuntimeInspectorBody({ snapshot }: { snapshot: RuntimeInspectorSnapshot }) {
  const { entity, events } = snapshot;
  const [copied, setCopied] = useState(false);
  const copyContext = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        kind: entity.kind,
        state: entity.state,
        session_id: entity.sessionId ?? null,
        pane_id: entity.paneId ?? null,
        instance_id: entity.instanceId ?? null,
        bead_id: entity.beadId ?? null,
        chain_id: entity.chainId ?? null,
        role: entity.role ?? null,
        runtime: entity.runtime ?? null,
        branch: entity.branch ?? null,
        worktree: entity.worktree ?? null,
      }, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="runtime-sidebar-inspector">
      <div className="runtime-sidebar-state-row">
        <span className={`runtime-state-dot runtime-state-dot--${entity.tone}`} />
        <strong>{entity.state.replaceAll("_", " ")}</strong>
        <span>{entity.specialistJob ? `Specialist: ${entity.specialistJob.status}` : "runtime fact"}</span>
      </div>
      <button type="button" className="runtime-sidebar-copy" onClick={() => void copyContext()}>{copied ? "Copied" : "Copy context for agent"}</button>
      <RuntimeFields title="Runtime identity" fields={[
        ["Session", entity.sessionName ?? entity.sessionId],
        ["Pane", entity.paneId],
        ["Instance", entity.instanceId],
        ["Runtime", entity.runtime ?? entity.command],
      ]} />
      <RuntimeFields title="Workflow correlation" fields={[
        ["Bead", entity.beadId],
        ["Chain", entity.chainId],
        ["Role", entity.role],
        ["Parent pane", entity.parentPaneId],
      ]} />
      <RuntimeFields title="Workspace" fields={[
        ["Branch", entity.branch],
        ["Worktree", entity.worktree],
        ["Path", entity.path],
      ]} />
      <section className="runtime-sidebar-section">
        <div className="runtime-sidebar-section-title">Recent evidence</div>
        {events.length ? events.map((event) => (
          <div className="runtime-sidebar-event" key={event.id}>
            <div><span>{event.source}</span><time>{formatRelative(event.atMs)}</time></div>
            <strong>{event.type}</strong>
            <p>{event.summary}</p>
          </div>
        )) : <div className="runtime-sidebar-empty">No correlated events in the current window.</div>}
      </section>
    </div>
  );
}

function RuntimeFields({ title, fields }: { title: string; fields: Array<[string, string | number | null | undefined]> }) {
  const visible = fields.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!visible.length) return null;
  return (
    <section className="runtime-sidebar-section">
      <div className="runtime-sidebar-section-title">{title}</div>
      {visible.map(([label, value]) => (
        <div className="runtime-sidebar-field" key={label}>
          <span>{label}</span><code title={String(value)}>{String(value)}</code>
        </div>
      ))}
    </section>
  );
}

function formatRelative(atMs: number): string {
  if (!atMs) return "unknown";
  const delta = Math.max(0, Date.now() - atMs);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function startResize(event: ReactPointerEvent<HTMLDivElement>, setSidebarWidth: (width: number) => void, dragCleanupRef: React.MutableRefObject<null | (() => void)>) {
  if (event.button !== 0) return;
  event.preventDefault();
  const target = event.currentTarget;
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    logClientEvent("right_sidebar.pointercapture.fallback", { pointerId: event.pointerId });
  }

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", cleanup);
    window.removeEventListener("pointercancel", cleanup);
    target.removeEventListener("lostpointercapture", cleanup);
    try { target.releasePointerCapture(event.pointerId); } catch { /* best effort */ }
    dragCleanupRef.current = null;
  };
  const onMove = (moveEvent: PointerEvent) => setSidebarWidth(window.innerWidth - moveEvent.clientX);
  dragCleanupRef.current?.();
  dragCleanupRef.current = cleanup;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", cleanup, { once: true });
  window.addEventListener("pointercancel", cleanup, { once: true });
  target.addEventListener("lostpointercapture", cleanup, { once: true });
}
