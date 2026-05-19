import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BottomDrawerTabBar } from "./BottomDrawerTabBar.tsx";
import { SpecialistsTabPanel } from "../beads/SpecialistsTabPanel.tsx";
import { LogsTabPanel } from "./LogsTabPanel.tsx";
import { useShellStore } from "../../stores/shell.ts";

console.log("[drawer] BottomDrawer module loaded — onMouseDown+document version A");

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
      <div
        className="bottom-drawer-resizer"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        onMouseDown={(event) => startResize(event, setDrawerHeight)}
      />
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

function startResize(event: ReactMouseEvent<HTMLDivElement>, setDrawerHeight: (height: number) => void) {
  if (event.button !== 0) return;

  event.preventDefault();
  document.body.style.userSelect = "none";
  document.body.style.cursor = "row-resize";

  const onMove = (moveEvent: globalThis.MouseEvent) => {
    const newH = window.innerHeight - moveEvent.clientY;
    console.log("[drawer] move", moveEvent.clientY, "→ h", newH);
    setDrawerHeight(newH);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp, { once: true });
}

function toggleMaximize(
  currentHeight: number,
  restoredHeight: number | null,
  setRestoredHeight: (height: number | null) => void,
  setDrawerHeight: (height: number) => void,
) {
  if (restoredHeight === null) {
    const maximizedHeight = window.innerHeight - MAXIMIZED_OFFSET;
    console.log("[drawer] toggleMaximize current=", currentHeight, "restored=", maximizedHeight);
    setRestoredHeight(currentHeight);
    setDrawerHeight(maximizedHeight);
    return;
  }

  console.log("[drawer] toggleMaximize current=", currentHeight, "restored=", restoredHeight);
  setDrawerHeight(restoredHeight);
  setRestoredHeight(null);
}
