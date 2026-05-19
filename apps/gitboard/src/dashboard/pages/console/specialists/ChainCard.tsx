import { AlertIcon, CheckIcon, ClockIcon, PlayIcon, XCircleIcon, DotFillIcon } from "@primer/octicons-react";
import type { ComponentType } from "react";
import type { ChainStatus, ChainSummary } from "../../../hooks/useChains.ts";

const STATUS_ICON: Record<ChainStatus, ComponentType<{ size?: number }>> = {
  running: PlayIcon,
  waiting: ClockIcon,
  done: CheckIcon,
  error: AlertIcon,
  cancelled: XCircleIcon,
};

export function ChainCard({ chain, selected, onSelect }: { chain: ChainSummary; selected: boolean; onSelect: () => void }) {
  const StatusIcon = STATUS_ICON[chain.status];
  return (
    <button type="button" className={selected ? "console-specialists-card is-selected" : chain.status === "running" ? "console-specialists-card is-live" : "console-specialists-card"} onClick={onSelect}>
      <div className="console-specialists-card-row console-specialists-card-header">
        <span className="console-specialists-card-id">{chain.rootBeadId}</span>
        <span className="console-specialists-card-title">{chain.title}</span>
        <span className="console-specialists-card-badge"><StatusIcon size={12} />{chain.status}</span>
        <span className="console-specialists-card-count">{chain.jobs.length}</span>
      </div>
      <div className="console-specialists-card-row console-specialists-card-roles">{chain.roles.map((role) => <span key={role.role} className="console-specialists-role-chip"><DotFillIcon size={8} /><span>{role.role}</span></span>)}</div>
      <div className="console-specialists-card-row console-specialists-card-footer"><span>{formatElapsed(chain.elapsedMs)}</span><span>{chain.lastMessage || "—"}</span></div>
    </button>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}
