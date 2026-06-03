import type { ChainSummary } from "../../../hooks/useChains.ts";
import type { ChainIssueContext } from "./chainIssueContext.ts";
import { ChainListRow } from "./ChainListRow.tsx";

export function ChainCard({ chain, issueContext, selected, onSelect }: { chain: ChainSummary; issueContext?: ChainIssueContext; selected: boolean; onSelect: () => void }) {
  const classes = [
    "console-specialists-card",
    selected ? "is-selected" : "",
    chain.status === "starting" || chain.status === "running" || chain.status === "waiting" ? "is-live" : "",
  ].filter(Boolean).join(" ");

  return (
    <button type="button" className={classes} onClick={onSelect}>
      <ChainListRow chain={chain} issueContext={issueContext} />
    </button>
  );
}
