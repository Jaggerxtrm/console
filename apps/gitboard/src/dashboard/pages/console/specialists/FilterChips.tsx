import type { ChainStatus } from "../../../hooks/useChains.ts";

const FILTERS: Array<{ id: ChainStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "starting", label: "Starting" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "error", label: "Error" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

export function FilterChips({ active, counts = {}, onToggle }: { active: Set<ChainStatus | "all">; counts?: Partial<Record<ChainStatus, number>>; onToggle: (status: ChainStatus | "all") => void }) {
  const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
  return (
    <div className="console-specialists-filters">
      {FILTERS.map((filter) => {
        const count = filter.id === "all" ? total : counts[filter.id] ?? 0;
        return (
          <button key={filter.id} type="button" className={active.has(filter.id) ? "drawer-log-chip is-active" : "drawer-log-chip"} onClick={() => onToggle(filter.id)}>
            <span>{filter.label}</span>
            <span className="console-specialists-filter-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
