import type { ReactNode } from "react";
import { GearIcon, ScreenFullIcon, ScreenNormalIcon, TerminalIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import type { BottomDrawerTab } from "./BottomDrawer.tsx";

export function BottomDrawerTabBar({ activeTab, open, isMaximized, onSelect, onClose, onClearLogs, onToggleMaximize }: { activeTab: BottomDrawerTab; open: boolean; isMaximized: boolean; onSelect: (tab: BottomDrawerTab) => void; onClose: () => void; onClearLogs: () => void; onToggleMaximize: () => void; }) {
  return (
    <div className="bottom-drawer-tabbar" role="tablist" aria-label="Bottom drawer tabs">
      <div className="bottom-drawer-tabs">
        <TabButton active={activeTab === "logs"} onClick={() => onSelect("logs")} icon={<TerminalIcon size={12} />}>Logs</TabButton>
        <TabButton active={activeTab === "specialists"} onClick={() => onSelect("specialists")} icon={<GearIcon size={12} />}>Specialists</TabButton>
        <TabButton active={activeTab === "terminal"} onClick={() => onSelect("terminal")} icon={<TerminalIcon size={12} />}>Terminal</TabButton>
      </div>
      <div className="bottom-drawer-actions">
        {activeTab === "logs" && <IconButton title="clear logs" onClick={onClearLogs}><TrashIcon size={12} /></IconButton>}
        <IconButton title={isMaximized ? "restore drawer" : "maximize drawer"} onClick={onToggleMaximize}>{isMaximized ? <ScreenNormalIcon size={12} /> : <ScreenFullIcon size={12} />}</IconButton>
        <IconButton title={open ? "close drawer" : "open drawer"} onClick={onClose}><XIcon size={12} /></IconButton>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode; }) {
  return <button type="button" role="tab" aria-selected={active} className={active ? "bottom-drawer-tab is-active" : "bottom-drawer-tab"} onClick={onClick}>{icon}<span>{children}</span></button>;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode; }) {
  return <button type="button" className="bottom-drawer-icon-btn" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}
