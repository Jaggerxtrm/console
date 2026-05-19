import { useEffect, useMemo, useState } from "react";
import { AlertIcon, DotFillIcon } from "@primer/octicons-react";
import { useChains, type ChainStatus, type ChainSummary } from "../../hooks/useChains.ts";
import { ChainCard } from "./specialists/ChainCard.tsx";
import { ChainDetailPane } from "./specialists/ChainDetailPane.tsx";
import { FilterChips } from "./specialists/FilterChips.tsx";

export function Specialists() {
  const { chains, loading, error } = useChains();
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<ChainStatus | "all">>(new Set(["all"]));

  const visibleChains = useMemo(() => chains.filter((chain) => matchesFilters(chain, filters)), [chains, filters]);

  useEffect(() => {
    if (visibleChains.length === 0) {
      setSelectedChainId(null);
      return;
    }
    if (!selectedChainId || !visibleChains.some((chain) => chain.chainId === selectedChainId)) {
      setSelectedChainId(visibleChains[0]!.chainId);
    }
  }, [selectedChainId, visibleChains]);

  const selectedChain = visibleChains.find((chain) => chain.chainId === selectedChainId) ?? null;
  const empty = !loading && !error && chains.length === 0;

  return (
    <section className="console-specialists-shell">
      <div className="console-specialists-list-pane">
        <FilterChips active={filters} onToggle={(status) => setFilters((current) => toggleFilter(current, status))} />
        {error ? <div className="console-specialists-empty"><AlertIcon size={12} />{error}</div> : null}
        {empty ? (
          <div className="console-specialists-empty-state-message"><DotFillIcon size={10} /><span>No specialist chains for this project yet</span></div>
        ) : (
          <div className="console-specialists-card-list">
            {visibleChains.map((chain) => <ChainCard key={chain.chainId} chain={chain} selected={selectedChain?.chainId === chain.chainId} onSelect={() => setSelectedChainId(chain.chainId)} />)}
          </div>
        )}
      </div>
      <div className="console-specialists-detail-pane"><ChainDetailPane chain={selectedChain} /></div>
    </section>
  );
}

function matchesFilters(chain: ChainSummary, filters: Set<ChainStatus | "all">): boolean {
  if (filters.has("all")) return true;
  return filters.has(chain.status);
}

function toggleFilter(current: Set<ChainStatus | "all">, status: ChainStatus | "all"): Set<ChainStatus | "all"> {
  if (status === "all") return new Set(["all"]);
  const next = new Set(current);
  next.delete("all");
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next.size === 0 ? new Set(["all"]) : next;
}
