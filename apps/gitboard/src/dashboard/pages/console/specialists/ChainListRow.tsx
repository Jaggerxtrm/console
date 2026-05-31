import { createElement, useEffect } from "react";
import { logClientEvent } from "../../../lib/client-log.ts";
import { TYPE_CONFIG } from "../../../lib/type-palette.ts";
import type { ChainSummary } from "../../../hooks/useChains.ts";

const ROLE_PALETTE: Record<string, { fg: string; bg: string }> = {
  bug: { fg: TYPE_CONFIG.bug.color, bg: "rgba(217, 95, 81, 0.10)" },
  feature: { fg: TYPE_CONFIG.feature.color, bg: "rgba(65, 105, 225, 0.10)" },
  task: { fg: TYPE_CONFIG.task.color, bg: "rgba(255, 255, 255, 0.04)" },
  epic: { fg: TYPE_CONFIG.epic.color, bg: "rgba(163, 113, 247, 0.10)" },
  chore: { fg: TYPE_CONFIG.chore.color, bg: "rgba(255, 255, 255, 0.04)" },
} as const;

export function ChainListRow({ chain }: { chain: ChainSummary }) {
  const role = chain.roles[0]?.role ?? "unknown";
  const rolePalette = ROLE_PALETTE[role] ?? ROLE_PALETTE.task;

  useEffect(() => {
    if (role in ROLE_PALETTE) return;
    logClientEvent("cockpit.row.palette.mismatch", { role, chainId: chain.chainId });
  }, [chain.chainId, role]);
  return createElement(
    "div",
    { className: "console-specialists-chain-row" },
    createElement(
      "div",
      { className: "console-specialists-chain-row-identity" },
      createElement("span", { className: "console-specialists-chain-row-id" }, chain.rootBeadId),
      createElement("span", { className: "console-specialists-chain-row-sep" }, "/"),
      createElement("span", { className: "console-specialists-chain-row-title" }, chain.title),
    ),
    createElement(
      "div",
      { className: "console-specialists-chain-row-meta" },
      createElement(
        "span",
        { className: "console-specialists-chain-row-chip", style: { color: rolePalette.fg, background: rolePalette.bg } },
        createElement("span", { className: "console-specialists-chain-row-chip-dot" }),
        createElement("span", null, role),
      ),
      createElement("span", { className: "console-specialists-chain-row-sep" }, "/"),
      createElement("span", { className: "console-specialists-chain-row-job" }, chain.jobs[chain.jobs.length - 1]?.jobId ?? chain.chainId),
    ),
  );
}
