import { useEffect, useMemo, useRef, useState } from "react";
import { AlertIcon, DotFillIcon } from "@primer/octicons-react";
import { logClientEvent } from "../../lib/client-log.ts";
import { useChains, type ChainStatus } from "../../hooks/useChains.ts";
import { BeadActivityPane } from "../../components/specialists/BeadActivityPane.tsx";
import { ChainCard } from "./specialists/ChainCard.tsx";
import { FilterChips } from "./specialists/FilterChips.tsx";
import { buildBeadActivitySwappedTelemetry, buildChainSelectedTelemetry, buildFirstPaintTelemetry, buildListRenderedTelemetry, deriveSelection, toggleFilter, type CockpitFilters } from "./specialists/cockpitSelection.ts";

export function Specialists() {
  const { chains, loading, error } = useChains();
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CockpitFilters>(new Set(["all"]));
  const firstPaintLogged = useRef(false);
  const lastSelectedChainId = useRef<string | null>(null);

  const selection = useMemo(() => deriveSelection(chains, filters, selectedChainId), [chains, filters, selectedChainId]);
  const typesByCount = useMemo(() => countByStatus(selection.visibleChains), [selection.visibleChains]);

  useEffect(() => {
    logClientEvent("cockpit.list.rendered", buildListRenderedTelemetry(selection.visibleChains, typesByCount));
    if (!firstPaintLogged.current && !loading && !error) {
      firstPaintLogged.current = true;
      logClientEvent("cockpit.list.first_paint", buildFirstPaintTelemetry(selection.visibleChains));
    }
  }, [error, loading, selection.visibleChains, typesByCount]);

  useEffect(() => {
    if (selection.selectedChainId === selectedChainId) return;
    setSelectedChainId(selection.selectedChainId);
  }, [selectedChainId, selection.selectedChainId]);

  useEffect(() => {
    if (!selection.selectedChainId || lastSelectedChainId.current === selection.selectedChainId) return;
    lastSelectedChainId.current = selection.selectedChainId;
    logClientEvent("cockpit.chain.selected", buildChainSelectedTelemetry(selection.selectedChainId));
  }, [selection.selectedChainId]);

  useEffect(() => {
    if (!selection.selectedChain) return;
    logClientEvent("cockpit.bead_activity.swapped", buildBeadActivitySwappedTelemetry(selection.selectedChain));
  }, [selection.selectedChain]);

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
            {selection.visibleChains.map((chain) => <ChainCard key={chain.chainId} chain={chain} selected={selection.selectedChain?.chainId === chain.chainId} onSelect={() => setSelectedChainId(chain.chainId)} />)}
          </div>
        )}
      </div>
      <div className="console-specialists-detail-pane">
        {selection.selectedChain ? <BeadActivityPane beadId={selection.selectedChain.rootBeadId} /> : <div className="console-specialists-detail console-specialists-detail-empty-state"><div className="console-specialists-empty-mark"><DotFillIcon size={10} /></div><div>Select a chain to see details</div></div>}
      </div>
    </section>
  );
}

function countByStatus(chains: Array<{ status: ChainStatus }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chain of chains) counts[chain.status] = (counts[chain.status] ?? 0) + 1;
  return counts;
}
