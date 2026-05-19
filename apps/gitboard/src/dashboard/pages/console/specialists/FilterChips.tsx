import type { ChainStatus } from "../../../hooks/useChains.ts";

const FILTERS: Array<{ id: ChainStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "error", label: "Error" },
  { id: "cancelled", label: "Cancelled" },
];

export function FilterChips({ active, onToggle }: { active: Set<ChainStatus | "all">; onToggle: (status: ChainStatus | "all") => void }) {
  return <div className="console-specialists-filters">{FILTERS.map((filter) => <button key={filter.id} type="button" className={active.has(filter.id) ? "drawer-log-chip is-active" : "drawer-log-chip"} onClick={() => onToggle(filter.id)}>{filter.label}</button>)}</div>;
}
