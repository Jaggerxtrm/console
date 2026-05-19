import type { ReactNode } from "react";

export type BottomDrawerTab = "logs" | "specialists";

export function BottomDrawerTabBar({ activeTab, onSelect }: { activeTab: BottomDrawerTab; onSelect: (tab: BottomDrawerTab) => void; }) {
  return (
    <div className="bottom-drawer-tabbar" role="tablist" aria-label="Bottom drawer tabs">
      <TabButton active={activeTab === "logs"} onClick={() => onSelect("logs")}>Logs</TabButton>
      <TabButton active={activeTab === "specialists"} onClick={() => onSelect("specialists")}>Specialists</TabButton>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode; }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={active ? "bottom-drawer-tab is-active" : "bottom-drawer-tab"} onClick={onClick}>
      {children}
    </button>
  );
}
