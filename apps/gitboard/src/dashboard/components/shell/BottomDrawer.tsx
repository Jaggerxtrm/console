import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BottomDrawerTabBar } from "./BottomDrawerTabBar.tsx";
import { SpecialistsTabPanel } from "../beads/SpecialistsTabPanel.tsx";
import { LogsTabPanel } from "./LogsTabPanel.tsx";
import { useShellStore } from "../../stores/shell.ts";

export type BottomDrawerTab = "logs" | "specialists";

const MAXIMIZED_OFFSET = 24;

export function BottomDrawer() {
  const open = useShellStore((s) => s.drawerOpen);
  const height = useShellStore((s) => s.drawerHeight);
  const tab = useShellStore((s) => s.drawerTab);
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen);
  const setDrawerHeight = useShellStore((s) => s.setDrawerHeight);
  const setDrawerTab = useShellStore((s) => s.setDrawerTab);
  const [restoredHeight, setRestoredHeight] = useState<number | null>(null);
  const isMaximized = restoredHeight !== null;

  useEffect(() => {
    if (!open) {
      setRestoredHeight(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <section className="bottom-drawer" data-open={open} style={{ height }}>
      <div className="bottom-drawer-resizer" role="separator" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => startResize(event, setDrawerHeight)} />
      <BottomDrawerTabBar
        activeTab={tab}
        open={open}
        isMaximized={isMaximized}
        onSelect={(next) => {
          setDrawerTab(next);
          setDrawerOpen(true);
        }}
        onClose={() => setDrawerOpen(false)}
        onClearLogs={() => {}}
        onToggleMaximize={() => toggleMaximize(height, restoredHeight, setRestoredHeight, setDrawerHeight)}
      />
      <div className="bottom-drawer-body">{tab === "logs" ? <LogsTabPanel onClear={() => {}} /> : <SpecialistsTabPanel />}</div>
    </section>
  );
}

function startResize(event: ReactPointerEvent<HTMLDivElement>, setDrawerHeight: (height: number) => void) {
  event.preventDefault();
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const target = event.currentTarget;
  target.setPointerCapture(event.pointerId);

  const onMove = (moveEvent: globalThis.PointerEvent) => {
    setDrawerHeight(window.innerHeight - moveEvent.clientY);
  };
  const onUp = (upEvent: globalThis.PointerEvent) => {
    if (target.hasPointerCapture(upEvent.pointerId)) {
      target.releasePointerCapture(upEvent.pointerId);
    }
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onUp);
  };

  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp);
  target.addEventListener("pointercancel", onUp);
}

function toggleMaximize(
  currentHeight: number,
  restoredHeight: number | null,
  setRestoredHeight: (height: number | null) => void,
  setDrawerHeight: (height: number) => void,
) {
  if (restoredHeight === null) {
    setRestoredHeight(currentHeight);
    setDrawerHeight(window.innerHeight - MAXIMIZED_OFFSET);
    return;
  }

  setDrawerHeight(restoredHeight);
  setRestoredHeight(null);
}
