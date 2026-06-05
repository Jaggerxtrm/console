import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { XIcon } from "@primer/octicons-react";
import { BeadActivityPane } from "../specialists/BeadActivityPane.tsx";
import { selectSidebar, useShellStore } from "../../stores/shell.ts";
import { logClientEvent } from "../../lib/client-log.ts";

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

  if (!sidebar.open || !sidebar.beadId) return null;
  const beadId = sidebar.beadId;

  return (
    <>
      <div className="right-sidebar-scrim" onClick={() => closeSidebar("click_out")} />
      <aside className="right-sidebar" aria-label="Bead details" style={{ width: sidebar.width }}>
        <div className="right-sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" style={{ width: EDGE_HIT_AREA_PX, touchAction: "none" }} onPointerDown={(event) => startResize(event, setSidebarWidth, dragCleanupRef)} />
        <header className="right-sidebar-header">
          <div className="right-sidebar-title-group">
            <div className="right-sidebar-eyebrow">Activity inspector</div>
            <div className="right-sidebar-title">{beadId}</div>
            {sidebar.jobId ? <div className="right-sidebar-subtitle">{sidebar.jobId}</div> : null}
          </div>
          <button type="button" className="right-sidebar-close" aria-label="Close sidebar" onClick={() => closeSidebar("x_button")}>
            <XIcon size={16} />
          </button>
        </header>
        <div className="right-sidebar-body">
          <BeadActivityPane key={beadId} beadId={beadId} jobIdHint={sidebar.jobId} />
        </div>
      </aside>
    </>
  );
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
    try {
      target.releasePointerCapture(event.pointerId);
    } catch {
      // pointer capture best effort
    }
    dragCleanupRef.current = null;
  };

  const onMove = (moveEvent: PointerEvent) => {
    const nextWidth = window.innerWidth - moveEvent.clientX;
    setSidebarWidth(nextWidth);
  };

  dragCleanupRef.current?.();
  dragCleanupRef.current = cleanup;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", cleanup, { once: true });
  window.addEventListener("pointercancel", cleanup, { once: true });
  target.addEventListener("lostpointercapture", cleanup, { once: true });
}
