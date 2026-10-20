import { useMemo, useState } from "react";
import type { RuntimeEntity, RuntimeObservabilityModel, RuntimeTimelineEvent } from "../../../../types/runtime-observability.ts";

interface RuntimeOperationsProps {
  model: RuntimeObservabilityModel;
  selectedId: string | null;
  query: string;
  scope: "all" | "active" | "attention";
  onSelect: (id: string) => void;
}

export function RuntimeOperations({ model, selectedId, query, scope, onSelect }: RuntimeOperationsProps) {
  const [source, setSource] = useState<"all" | "xtmux" | "specialists">("all");
  const timeline = useMemo(() => model.timeline.filter((event) => {
    if (source !== "all" && event.source !== source) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return [event.type, event.summary, event.paneId, event.beadId, event.chainId, event.correlationId]
      .some((value) => value?.toLowerCase().includes(needle));
  }), [model.timeline, query, source]);

  return (
    <div className="runtime-operations">
      <aside className="runtime-hierarchy">
        <div className="runtime-section-head">
          <div>
            <div className="runtime-section-kicker">live hierarchy</div>
            <div className="runtime-section-title">Sessions & dispatches</div>
          </div>
          <span className="runtime-count-chip">{model.counts.panes}</span>
        </div>
        <div className="runtime-hierarchy__scroll">
          {model.sessions.map((group) => {
            const rows = orderPanes(group.panes).filter(({ entity }) => matchesEntity(entity, query, scope));
            if (rows.length === 0 && scope !== "all") return null;
            return (
              <div className="runtime-session-group" key={group.entity.id}>
                <button
                  type="button"
                  className={`runtime-session-row${selectedId === group.entity.id ? " is-selected" : ""}`}
                  onClick={() => onSelect(group.entity.id)}
                >
                  <span className={`runtime-state-dot runtime-state-dot--${group.entity.tone}`} />
                  <span className="runtime-session-row__name">{group.entity.title}</span>
                  <span className="runtime-session-row__count">{group.entity.paneCount}</span>
                </button>
                {rows.map(({ entity, depth }) => (
                  <button
                    type="button"
                    key={entity.id}
                    className={`runtime-pane-row${selectedId === entity.id ? " is-selected" : ""}`}
                    style={{ paddingLeft: `${20 + depth * 18}px` }}
                    onClick={() => onSelect(entity.id)}
                  >
                    <span className="runtime-pane-row__branch">{depth > 0 ? "↳" : "·"}</span>
                    <span className={`runtime-state-dot runtime-state-dot--${entity.tone}`} />
                    <span className="runtime-pane-row__body">
                      <strong>{entity.title}</strong>
                      <small>{entity.paneId}{entity.beadId ? ` · ${entity.beadId}` : ""}</small>
                    </span>
                    <span className="runtime-pane-row__state">{shortState(entity)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {model.unboundSpecialists.length > 0 ? (
            <div className="runtime-session-group">
              <div className="runtime-hierarchy-label">Workflow only</div>
              {model.unboundSpecialists.filter((entity) => matchesEntity(entity, query, scope)).map((entity) => (
                <button
                  type="button"
                  key={entity.id}
                  className={`runtime-pane-row${selectedId === entity.id ? " is-selected" : ""}`}
                  onClick={() => onSelect(entity.id)}
                >
                  <span className="runtime-pane-row__branch">·</span>
                  <span className={`runtime-state-dot runtime-state-dot--${entity.tone}`} />
                  <span className="runtime-pane-row__body">
                    <strong>{entity.title}</strong>
                    <small>{entity.beadId} · no exact runtime binding</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="runtime-event-log">
        <div className="runtime-section-head runtime-section-head--events">
          <div>
            <div className="runtime-section-kicker">ordered evidence</div>
            <div className="runtime-section-title">Event log</div>
          </div>
          <div className="runtime-source-toggle">
            {(["all", "xtmux", "specialists"] as const).map((item) => (
              <button
                type="button"
                key={item}
                className={source === item ? "is-active" : ""}
                onClick={() => setSource(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="runtime-event-log__scroll">
          {timeline.slice(0, 240).map((event) => <EventRow key={event.id} event={event} />)}
          {timeline.length === 0 ? <div className="runtime-empty runtime-empty--compact">No events match the current filter.</div> : null}
        </div>
      </section>
    </div>
  );
}

function EventRow({ event }: { event: RuntimeTimelineEvent }) {
  return (
    <div className="runtime-event-row">
      <time dateTime={new Date(event.atMs).toISOString()}>{formatTime(event.atMs)}</time>
      <span className={`runtime-provenance runtime-provenance--${event.source}`}>{event.source}</span>
      <div className="runtime-event-row__body">
        <strong>{event.type}</strong>
        <span>{event.summary}</span>
      </div>
      <div className="runtime-event-row__refs">
        {event.paneId ? <code>{event.paneId}</code> : null}
        {event.beadId ? <code>{event.beadId}</code> : null}
      </div>
    </div>
  );
}

function orderPanes(panes: RuntimeEntity[]): Array<{ entity: RuntimeEntity; depth: number }> {
  const byParent = new Map<string, RuntimeEntity[]>();
  const roots: RuntimeEntity[] = [];
  const ids = new Set(panes.map((pane) => pane.paneId).filter(Boolean));

  for (const pane of panes) {
    if (pane.parentPaneId && ids.has(pane.parentPaneId)) {
      const children = byParent.get(pane.parentPaneId) ?? [];
      children.push(pane);
      byParent.set(pane.parentPaneId, children);
    } else {
      roots.push(pane);
    }
  }

  const result: Array<{ entity: RuntimeEntity; depth: number }> = [];
  const visit = (entity: RuntimeEntity, depth: number, seen: Set<string>) => {
    if (seen.has(entity.id)) return;
    seen.add(entity.id);
    result.push({ entity, depth });
    for (const child of byParent.get(entity.paneId ?? "") ?? []) visit(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of roots) visit(root, 0, seen);
  for (const pane of panes) visit(pane, 0, seen);
  return result;
}

function matchesEntity(entity: RuntimeEntity, query: string, scope: "all" | "active" | "attention"): boolean {
  if (scope === "active" && entity.tone !== "active" && entity.tone !== "attention") return false;
  if (scope === "attention" && entity.tone !== "attention") return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entity.title, entity.subtitle, entity.paneId, entity.beadId, entity.role, entity.runtime, entity.path, entity.branch, entity.chainId]
    .some((value) => value?.toLowerCase().includes(needle));
}

function shortState(entity: RuntimeEntity): string {
  if (entity.specialistJob && entity.specialistJob.status !== entity.state) return `${entity.state} · sp:${entity.specialistJob.status}`;
  return entity.state.replaceAll("_", " ");
}

function formatTime(value: number): string {
  if (!value) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}
