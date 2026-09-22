import { useCallback, useEffect, useMemo, useState } from "react";
import { useRuntimeObservability } from "../../hooks/useRuntimeObservability.ts";
import { useShellStore } from "../../stores/shell.ts";
import { RuntimeOperations } from "./runtime-observability/RuntimeOperations.tsx";
import { RuntimeTopologyGraph } from "./runtime-observability/RuntimeTopologyGraph.tsx";
import { relatedEvents } from "./runtime-observability/model.ts";
import "./runtime-observability/runtime-observability.css";

export function Observability() {
  const runtime = useRuntimeObservability();
  const openRuntimeSidebar = useShellStore((state) => state.openRuntimeSidebar);
  const [view, setView] = useState<"graph" | "operations">("graph");
  const [scope, setScope] = useState<"all" | "active" | "attention">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && runtime.model.entities.some((entity) => entity.id === selectedId)) return;
    const next = runtime.model.entities.find((entity) => entity.kind === "pane" && entity.tone === "attention")
      ?? runtime.model.entities.find((entity) => entity.kind === "pane")
      ?? runtime.model.entities[0]
      ?? null;
    setSelectedId(next?.id ?? null);
  }, [runtime.model.entities, selectedId]);

  const selected = useMemo(
    () => runtime.model.entities.find((entity) => entity.id === selectedId) ?? null,
    [runtime.model.entities, selectedId],
  );

  const selectEntity = useCallback((id: string) => {
    setSelectedId(id);
    const entity = runtime.model.entities.find((candidate) => candidate.id === id);
    if (!entity) return;
    openRuntimeSidebar({
      entity,
      events: relatedEvents(runtime.model, entity, 12),
      capturedAtMs: Date.now(),
    });
  }, [openRuntimeSidebar, runtime.model]);

  return (
    <section className="runtime-observability">
      <header className="runtime-observability__header">
        <div className="runtime-observability__title">
          <h2>Runtime observability</h2>
          <span>xtmux runtime facts · Specialists workflow correlation</span>
        </div>
        <div className="runtime-observability__toolbar">
          <div className="runtime-segmented" aria-label="Observability view">
            <button type="button" className={view === "graph" ? "is-active" : ""} onClick={() => setView("graph")}>Graph</button>
            <button type="button" className={view === "operations" ? "is-active" : ""} onClick={() => setView("operations")}>Operations</button>
          </div>
          <button type="button" className="runtime-refresh-button" onClick={() => void runtime.refresh()}>{runtime.loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>

      <div className="runtime-observability__statusbar">
        <RuntimeStat label="sessions" value={runtime.model.counts.sessions} />
        <RuntimeStat label="panes" value={runtime.model.counts.panes} />
        <RuntimeStat label="agents" value={runtime.model.counts.agents} />
        <RuntimeStat label="specialists" value={runtime.model.counts.specialists} />
        <RuntimeStat label="need attention" value={runtime.model.counts.attention} attention={runtime.model.counts.attention > 0} />
        <RuntimeStat label="stale" value={runtime.model.counts.stale} attention={runtime.model.counts.stale > 0} />
        <span className="runtime-status-spacer" />
        <SourceHealth label="topology" health={runtime.overview?.source_health.topology} />
        <SourceHealth label="journal" health={runtime.overview?.source_health.journal} />
        <span className={`runtime-source-health ${runtime.specialistsError ? "is-degraded" : "is-ok"}`} title={runtime.specialistsError ?? "Specialists projection available"}>specialists</span>
      </div>

      {runtime.error ? <div className="runtime-error-banner">Partial data: {runtime.error}</div> : null}

      <div className="runtime-observability__filters">
        <input className="runtime-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter session, pane, bead, role, branch…" aria-label="Filter runtime observability" />
        {(["all", "active", "attention"] as const).map((item) => (
          <button type="button" key={item} className={`runtime-filter-button${scope === item ? " is-active" : ""}`} onClick={() => setScope(item)}>
            {item === "all" ? "All" : item === "active" ? "Active" : "Needs attention"}
          </button>
        ))}
      </div>

      <main className="runtime-observability__main">
        {view === "graph" ? (
          <RuntimeTopologyGraph model={runtime.model} selectedId={selected?.id ?? null} query={query} scope={scope} onSelect={selectEntity} />
        ) : (
          <RuntimeOperations model={runtime.model} selectedId={selected?.id ?? null} query={query} scope={scope} onSelect={selectEntity} />
        )}
      </main>
    </section>
  );
}

function RuntimeStat({ label, value, attention = false }: { label: string; value: number; attention?: boolean }) {
  return <span className={`runtime-stat${attention ? " runtime-stat--attention" : ""}`}><strong>{value}</strong>{label}</span>;
}

function SourceHealth({ label, health }: { label: string; health: { status: "ok" | "degraded"; latency_ms: number; error?: string } | undefined }) {
  const state = health?.status ?? "degraded";
  const title = health ? `${label}: ${health.status} · ${health.latency_ms}ms${health.error ? ` · ${health.error}` : ""}` : `${label}: waiting for data`;
  return <span className={`runtime-source-health ${state === "ok" ? "is-ok" : "is-degraded"}`} title={title}>{label}</span>;
}
