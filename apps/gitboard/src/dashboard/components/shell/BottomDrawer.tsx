import { useMemo, type MouseEvent } from "react";
import { BottomDrawerTabBar, type BottomDrawerTab } from "./BottomDrawerTabBar.tsx";
import { SpecialistsTabPanel } from "../beads/SpecialistsTabPanel.tsx";
import { useShellStore } from "../../stores/shell.ts";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

export function BottomDrawer() {
  const open = useShellStore((s) => s.drawerOpen);
  const height = useShellStore((s) => s.drawerHeight);
  const tab = useShellStore((s) => s.drawerTab);
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen);
  const setDrawerHeight = useShellStore((s) => s.setDrawerHeight);
  const setDrawerTab = useShellStore((s) => s.setDrawerTab);

  const clampedHeight = useMemo(() => clamp(height, MIN_HEIGHT, MAX_HEIGHT), [height]);

  return (
    <section className="bottom-drawer" data-open={open} style={{ height: open ? clampedHeight : MIN_HEIGHT }}>
      <BottomDrawerTabBar activeTab={tab} onSelect={setDrawerTab} />
      {open && <div className="bottom-drawer-body">{tab === "logs" ? <LogsPanel /> : <SpecialistsTabPanel />}</div>}
      <div className="bottom-drawer-resizer" role="separator" aria-orientation="horizontal" tabIndex={0} onMouseDown={(event) => startResize(event, setDrawerHeight)} />
      <button type="button" className="bottom-drawer-toggle" onClick={() => setDrawerOpen(!open)}>
        {open ? "collapse" : "open"}
      </button>
    </section>
  );
}

function LogsPanel() {
  return <div className="drawer-panel-message">Logs tab ready for forge-wvlj</div>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function startResize(event: MouseEvent, setDrawerHeight: (height: number) => void) {
  event.preventDefault();
  const onMove = (moveEvent: MouseEvent) => {
    setDrawerHeight(clamp(window.innerHeight - moveEvent.clientY, MIN_HEIGHT, MAX_HEIGHT));
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
