import { useEffect, useMemo, useRef, useState } from "react";
import { AlertIcon, DotFillIcon } from "@primer/octicons-react";
import { logClientEvent } from "../../lib/client-log.ts";
import { useChains, type ChainStatus } from "../../hooks/useChains.ts";
import { useGraphData } from "../../hooks/useGraphData.ts";
import { getSpecialistRepoScope } from "../../lib/specialist-scope.ts";
import { selectRepos, selectSelection, useShellStore } from "../../stores/shell.ts";
import { ChainCard } from "./specialists/ChainCard.tsx";
import { ChainDetailPane } from "./specialists/ChainDetailPane.tsx";
import { FilterChips } from "./specialists/FilterChips.tsx";
import { buildChainIssueContext } from "./specialists/chainIssueContext.ts";
import { buildBeadActivitySwappedTelemetry, buildChainSelectedTelemetry, buildFirstPaintTelemetry, buildListRenderedTelemetry, deriveSelection, toggleFilter, type CockpitFilters } from "./specialists/cockpitSelection.ts";

export function Specialists() {
  const selectionState = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const repoScope = useMemo(() => getSpecialistRepoScope(selectionState, repos), [repos, selectionState]);
  const chainRepoKeys = repoScope.repo ? repoScope.keys : ["__no_selected_project__"];
  const graphProjectId = repoScope.repo?.beadsProjectId ?? null;
  const { chains, loading, error } = useChains({ repoKeys: chainRepoKeys });
  const graph = useGraphData(graphProjectId);
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [filters, setFilters] = useState<CockpitFilters>(new Set(["all"]));
  const firstPaintLogged = useRef(false);
  const lastSelectedChainId = useRef<string | null>(null);

  const selection = useMemo(() => deriveSelection(chains, filters, selectedChainId), [chains, filters, selectedChainId]);
  const statusCounts = useMemo(() => countByStatus(chains), [chains]);
  const visibleStatusCounts = useMemo(() => countByStatus(selection.visibleChains), [selection.visibleChains]);
  const issueContextByChain = useMemo(() => new Map(chains.map((chain) => [chain.chainId, buildChainIssueContext(chain, graph.data)])), [chains, graph.data]);

  useEffect(() => {
    logClientEvent("cockpit.list.rendered", buildListRenderedTelemetry(selection.visibleChains, visibleStatusCounts));
    if (!firstPaintLogged.current && !loading && !error) {
      firstPaintLogged.current = true;
      logClientEvent("cockpit.list.first_paint", buildFirstPaintTelemetry(selection.visibleChains));
    }
  }, [error, loading, selection.visibleChains, visibleStatusCounts]);

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

  const noProject = !repoScope.repo;
  const empty = !loading && !error && !noProject && chains.length === 0;
  const filteredEmpty = !loading && !error && chains.length > 0 && selection.visibleChains.length === 0;

  return (
    <section className="console-specialists-shell">
      <div className="console-specialists-list-pane">
        <header className="console-specialists-header">
          <div>
            <div className="console-specialists-eyebrow">Specialist cockpit</div>
            <h2>{repoScope.label}</h2>
          </div>
          <div className="console-specialists-summary">
            <span>{chains.length} chains</span>
            <span>{selection.visibleChains.length} visible</span>
          </div>
        </header>
        <FilterChips active={filters} counts={statusCounts} onToggle={(status) => setFilters((current) => toggleFilter(current, status))} />
        {noProject ? <div className="console-specialists-empty-state-message"><DotFillIcon size={10} /><span>Pick a beads project to inspect specialist chains</span></div> : null}
        {error ? <div className="console-specialists-empty"><AlertIcon size={12} />{error}</div> : null}
        {graph.error ? <div className="console-specialists-empty" role="status"><AlertIcon size={12} />Graph context unavailable: {graph.error}</div> : null}
        {loading && chains.length === 0 && !noProject ? <div className="console-specialists-empty-state-message"><DotFillIcon size={10} /><span>Loading specialist chains...</span></div> : null}
        {empty ? (
          <div className="console-specialists-empty-state-message"><DotFillIcon size={10} /><span>No specialist chains for {repoScope.label} yet</span></div>
        ) : filteredEmpty ? (
          <div className="console-specialists-empty-state-message"><DotFillIcon size={10} /><span>No chains match the active filters</span></div>
        ) : (
          <div className="console-specialists-card-list">
            {selection.visibleChains.map((chain) => <ChainCard key={chain.chainId} chain={chain} issueContext={issueContextByChain.get(chain.chainId)} selected={selection.selectedChain?.chainId === chain.chainId} onSelect={() => setSelectedChainId(chain.chainId)} />)}
          </div>
        )}
      </div>
      <div className="console-specialists-detail-pane">
        <ChainDetailPane chain={selection.selectedChain} issueContext={selection.selectedChain ? issueContextByChain.get(selection.selectedChain.chainId) : undefined} graphLoading={graph.loading && !graph.data} projectId={graphProjectId} />
      </div>
    </section>
  );
}

function countByStatus(chains: Array<{ status: ChainStatus }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chain of chains) counts[chain.status] = (counts[chain.status] ?? 0) + 1;
  return counts;
}
