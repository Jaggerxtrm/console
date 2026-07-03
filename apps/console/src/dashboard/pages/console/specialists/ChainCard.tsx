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
    <div
      className={classes}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <ChainListRow chain={chain} issueContext={issueContext} />
    </div>
  );
}
