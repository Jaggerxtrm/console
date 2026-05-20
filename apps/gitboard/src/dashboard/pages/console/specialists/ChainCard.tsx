// 2-line compact card matching the JobBlock register:
//   identity row     : <rootBeadId> / <title>                 <N jobs>
//   classification   : <status-chip:role>* · <elapsed> · <last-message>
// Each role renders as a per-role status-coloured chip, mirroring the chips
// used in ChainDetailPane → ✓ green = done, ◐ amber = running, ⏲ muted =
// waiting, ⚠ red = error, ⨯ muted = cancelled.

import { AlertIcon, CheckIcon, ClockIcon, PlayIcon, XCircleIcon } from "@primer/octicons-react";
import type { ComponentType } from "react";
import type { ChainSummary } from "../../../hooks/useChains.ts";

const STATUS_PALETTE: Record<string, { fg: string; bg: string; Icon: ComponentType<{ size?: number }> }> = {
  running:   { fg: "var(--graph-state-wip)",    bg: "rgba(212, 161, 89, 0.10)", Icon: PlayIcon },
  waiting:   { fg: "var(--text-muted)",          bg: "rgba(255, 255, 255, 0.04)", Icon: ClockIcon },
  done:      { fg: "var(--graph-state-closed)", bg: "rgba(72, 159, 110, 0.10)", Icon: CheckIcon },
  error:     { fg: "var(--graph-priority-0)",   bg: "rgba(217, 95, 81, 0.10)", Icon: AlertIcon },
  cancelled: { fg: "var(--text-muted)",          bg: "rgba(255, 255, 255, 0.04)", Icon: XCircleIcon },
};

export function ChainCard({ chain, selected, onSelect }: { chain: ChainSummary; selected: boolean; onSelect: () => void }) {
  const classes = [
    "console-specialists-card",
    selected ? "is-selected" : "",
    chain.status === "running" ? "is-live" : "",
  ].filter(Boolean).join(" ");
  const railColor = (STATUS_PALETTE[chain.status] ?? STATUS_PALETTE.done).fg;
  return (
    <button type="button" className={classes} style={{ ["--rail-color" as string]: railColor }} onClick={onSelect}>
      <div className="console-specialists-card-identity">
        <span className="console-specialists-card-id">{chain.rootBeadId}</span>
        <span className="console-specialists-card-sep">/</span>
        <span className="console-specialists-card-title">{chain.title}</span>
      </div>
      <div className="console-specialists-card-meta">
        {chain.roles.map((role) => {
          const palette = STATUS_PALETTE[role.status] ?? STATUS_PALETTE.done;
          const Icon = palette.Icon;
          return (
            <span key={role.role} className="console-specialists-card-role-chip" style={{ color: palette.fg, background: palette.bg }}>
              <Icon size={9} />
              <span>{role.role}</span>
            </span>
          );
        })}
        {chain.roles.length > 0 ? <span className="console-specialists-card-sep">·</span> : null}
        <span className="console-specialists-card-elapsed">{formatElapsed(chain.elapsedMs)}</span>
        <span className="console-specialists-card-sep">·</span>
        <span className="console-specialists-card-last">{chain.lastMessage || "—"}</span>
      </div>
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

