import { useMemo, useState, type ReactNode } from "react";
import type { RuntimeEntity, RuntimeObservabilityModel } from "../../../../types/runtime-observability.ts";
import { relatedEvents } from "./model.ts";

interface RuntimeInspectorProps {
  model: RuntimeObservabilityModel;
  entity: RuntimeEntity | null;
}

export function RuntimeInspector({ model, entity }: RuntimeInspectorProps) {
  const [copied, setCopied] = useState(false);
  const events = useMemo(() => entity ? relatedEvents(model, entity, 10) : [], [entity, model]);

  if (!entity) {
    return (
      <aside className="runtime-inspector">
        <div className="runtime-inspector__empty">
          <div className="runtime-section-kicker">inspect</div>
          <strong>Select a session or runtime.</strong>
          <span>The inspector keeps runtime identity, workflow identity and recent evidence separate.</span>
        </div>
      </aside>
    );
  }

  const copyContext = async () => {
    const payload = {
      kind: entity.kind,
      session_id: entity.sessionId ?? null,
      pane_id: entity.paneId ?? null,
      instance_id: entity.instanceId ?? null,
      bead_id: entity.beadId ?? null,
      chain_id: entity.chainId ?? null,
      role: entity.role ?? null,
      runtime: entity.runtime ?? null,
      state: entity.state,
      branch: entity.branch ?? null,
      worktree: entity.worktree ?? null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="runtime-inspector">
      <div className="runtime-inspector__header">
        <div>
          <div className="runtime-section-kicker">selected {entity.kind}</div>
          <h3>{entity.title}</h3>
          <p>{entity.subtitle}</p>
        </div>
        <span className={`runtime-state-pill runtime-state-pill--${entity.tone}`}>{entity.state.replaceAll("_", " ")}</span>
      </div>

      <button type="button" className="runtime-copy-button" onClick={() => void copyContext()}>
        {copied ? "Copied" : "Copy context for agent"}
      </button>

      <InspectorSection title="Runtime identity">
        <InspectorField label="Session" value={entity.sessionName ?? entity.sessionId} mono />
        <InspectorField label="Pane" value={entity.paneId} mono />
        <InspectorField label="Instance" value={entity.instanceId} mono />
        <InspectorField label="Runtime" value={entity.runtime ?? entity.command} />
      </InspectorSection>

      <InspectorSection title="Workflow correlation">
        <InspectorField label="Bead" value={entity.beadId} mono />
        <InspectorField label="Chain" value={entity.chainId} mono />
        <InspectorField label="Role" value={entity.role} />
        <InspectorField label="Specialist" value={entity.specialistJob?.status ? `${entity.specialistJob.specialist ?? entity.specialistJob.chainKind ?? "specialist"} · ${entity.specialistJob.status}` : null} />
      </InspectorSection>

      <InspectorSection title="Workspace">
        <InspectorField label="Branch" value={entity.branch} mono />
        <InspectorField label="Worktree" value={entity.worktree} mono />
        <InspectorField label="Path" value={entity.path} mono />
        <InspectorField label="Parent pane" value={entity.parentPaneId} mono />
      </InspectorSection>

      <InspectorSection title="Recent evidence">
        {events.length > 0 ? events.map((event) => (
          <div className="runtime-inspector-event" key={event.id}>
            <div>
              <span className={`runtime-provenance runtime-provenance--${event.source}`}>{event.source}</span>
              <time>{formatRelative(event.atMs)}</time>
            </div>
            <strong>{event.type}</strong>
            <p>{event.summary}</p>
          </div>
        )) : <div className="runtime-muted">No correlated events in the current window.</div>}
      </InspectorSection>
    </aside>
  );
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="runtime-inspector-section">
      <div className="runtime-inspector-section__title">{title}</div>
      {children}
    </section>
  );
}

function InspectorField({ label, value, mono = false }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="runtime-inspector-field">
      <span>{label}</span>
      <strong className={mono ? "is-mono" : ""} title={String(value)}>{String(value)}</strong>
    </div>
  );
}

function formatRelative(atMs: number): string {
  if (!atMs) return "unknown";
  const delta = Math.max(0, Date.now() - atMs);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1_000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}
