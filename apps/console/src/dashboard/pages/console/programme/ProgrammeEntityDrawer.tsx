// ProgrammeEntityDrawer — read-only inspector for programme read-model entities.
// Adapts the BeadSideDrawer interaction pattern (resize, Escape close, back-stack,
// linked-entity navigation) with tabs Overview / Lineage / Evidence / GitHub / Metadata.
// Explicitly excludes mutation controls.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon, XIcon } from "@primer/octicons-react";
import type { ProgrammeEdge, ProgrammeNode, ProgrammeSnapshot } from "../../../../types/programme.ts";
import { useProgrammeDrawer, type ProgrammeDrawerTab } from "./programme-drawer.ts";

const TABS: Array<{ id: ProgrammeDrawerTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "lineage", label: "Lineage" },
  { id: "evidence", label: "Evidence" },
  { id: "github", label: "GitHub" },
  { id: "metadata", label: "Metadata" },
];

export function ProgrammeEntityDrawer({ snapshot }: { snapshot: ProgrammeSnapshot | null }) {
  const nodeId = useProgrammeDrawer((s) => s.nodeId);
  const tab = useProgrammeDrawer((s) => s.tab);
  const backStack = useProgrammeDrawer((s) => s.backStack);
  const width = useProgrammeDrawer((s) => s.width);
  const open = useProgrammeDrawer((s) => s.open);
  const back = useProgrammeDrawer((s) => s.back);
  const close = useProgrammeDrawer((s) => s.close);
  const setTab = useProgrammeDrawer((s) => s.setTab);
  const setWidth = useProgrammeDrawer((s) => s.setWidth);

  const node = useMemo(() => {
    if (!snapshot || !nodeId) return null;
    return snapshot.graph.nodes.find((n) => n.id === nodeId) ?? null;
  }, [snapshot, nodeId]);

  const edges = useMemo(() => {
    if (!snapshot || !nodeId) return [];
    return snapshot.graph.edges.filter((e) => e.source === nodeId || e.target === nodeId);
  }, [snapshot, nodeId]);

  const handleClose = useCallback(() => close(), [close]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    if (nodeId) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodeId, handleClose]);

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startW: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - event.clientX;
    setWidth(dragRef.current.startW + delta);
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  if (!nodeId || !snapshot || !node) return null;

  const linked = (id: string) => {
    if (snapshot.graph.nodes.some((n) => n.id === id)) open(id);
  };

  return createPortal(
    <div className="pd-drawer-backdrop" onMouseDown={handleClose}>
      <aside
        className="pd-drawer"
        style={{ width }}
        role="dialog"
        aria-label={`${node?.id ?? ""} programme entity inspector`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pd-drawer-resize" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} />
        <header className="pd-drawer-head">
          <div className="pd-drawer-head-left">
            {backStack.length > 0 ? (
              <button type="button" className="pd-icon-btn" onClick={back} title="Back" aria-label="Back">
                <ArrowLeftIcon size={14} />
              </button>
            ) : null}
            <div className="pd-drawer-kicker">{node?.kind ?? ""}</div>
          </div>
          <button type="button" className="pd-icon-btn" onClick={handleClose} title="Close (Esc)" aria-label="Close inspector">
            <XIcon size={14} />
          </button>
        </header>
        <div className="pd-drawer-title">{node?.id ?? ""}</div>
        <div className="pd-drawer-sub">{node?.title ?? ""}</div>
        {node?.status ? <span className="pd-badge">{node.status}</span> : null}
        <nav className="pd-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "pd-tab is-active" : "pd-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="pd-body">
          {tab === "overview" ? <OverviewTab node={node} /> : null}
          {tab === "lineage" ? <LineageTab nodeId={nodeId} edges={edges} onLinked={linked} /> : null}
          {tab === "evidence" ? <EvidenceTab node={node} snapshot={snapshot} /> : null}
          {tab === "github" ? <GithubTab node={node} snapshot={snapshot} /> : null}
          {tab === "metadata" ? <MetadataTab node={node} /> : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function OverviewTab({ node }: { node: ProgrammeNode }) {
  return (
    <div className="pd-section">
      <h4>Overview</h4>
      <dl className="pd-dl">
        <dt>ID</dt><dd className="pd-mono">{node.id}</dd>
        <dt>Kind</dt><dd>{node.kind}</dd>
        <dt>Status</dt><dd>{node.status ?? "—"}</dd>
        {node.source_path ? <><dt>Source</dt><dd className="pd-mono">{node.source_path}</dd></> : null}
      </dl>
      {node.kind === "collision" ? (
        <p className="pd-note">
          <strong>ID collision.</strong> Multiple canonical records share this identifier. The read model preserves the
          ambiguity via path-qualified records rather than guessing ownership.
        </p>
      ) : null}
      <p className="pd-muted">Read-only projection of the canonical programme read model. No mutation controls are provided.</p>
    </div>
  );
}

function LineageTab({ nodeId, edges, onLinked }: { nodeId: string; edges: ProgrammeEdge[]; onLinked: (id: string) => void }) {
  if (edges.length === 0) return <div className="pd-empty">No visible relations.</div>;
  const sorted = [...edges].sort((a, b) => a.relation.localeCompare(b.relation));
  return (
    <div className="pd-section">
      <h4>Lineage · {edges.length}</h4>
      <div className="pd-rel-list">
        {sorted.map((e, i) => {
          const outbound = e.source === nodeId;
          const other = outbound ? e.target : e.source;
          return (
            <div key={`${e.source}-${e.target}-${e.relation}-${i}`} className="pd-rel">
              <span className={`pd-rel-dir ${outbound ? "out" : "in"}`}>{outbound ? "→" : "←"}</span>
              <span className="pd-rel-relation">{e.relation}</span>
              <button type="button" className="pd-rel-link" onClick={() => onLinked(other)}>{other}</button>
              <span className={`pd-rel-strength ${e.strength}`}>{e.strength}</span>
              <div className="pd-rel-field">{e.field}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceTab({ node, snapshot }: { node: ProgrammeNode; snapshot: ProgrammeSnapshot }) {
  const isPublication = node.kind === "publication";
  const isState = node.kind === "state";
  const isJournal = node.kind === "journal";
  const pub = isPublication ? snapshot.publication_facts.find((p) => p.id === node.id) : null;
  const state = isState ? snapshot.state_records.find((s) => s.id === node.id) : null;
  const journal = isJournal ? snapshot.journals.find((j) => j.id === node.id) : null;
  return (
    <div className="pd-section">
      <h4>Evidence</h4>
      {pub ? (
        <dl className="pd-dl">
          <dt>Evidence class</dt><dd>{pub.evidence_class}</dd>
          <dt>Run date</dt><dd>{pub.run_date}</dd>
          <dt>State slot</dt><dd className="pd-mono">{pub.slot}</dd>
          <dt>Branch</dt><dd className="pd-mono">{pub.branch ?? "—"}</dd>
          {pub.pull_request ? <><dt>Pull request</dt><dd><a href={pub.pull_request} target="_blank" rel="noreferrer">{pub.pull_request}</a></dd></> : null}
          <dt>Logical actor</dt><dd>{pub.logical_actor}</dd>
          <dt>Principal set</dt><dd>{pub.principal_set}</dd>
        </dl>
      ) : state ? (
        <dl className="pd-dl">
          <dt>Status</dt><dd>{state.status}</dd>
          <dt>Actor</dt><dd className="pd-mono">{state.actor_id ?? "—"}</dd>
          <dt>Assignment</dt><dd className="pd-mono">{state.assignment_id ?? "—"}</dd>
          <dt>Updated</dt><dd>{state.updated_at ?? "—"}</dd>
        </dl>
      ) : journal ? (
        <dl className="pd-dl">
          <dt>Date</dt><dd>{journal.date ?? "—"}</dd>
          <dt>Classification</dt><dd>{journal.classification ?? "—"}</dd>
          <dt>Evidence cutoff</dt><dd>{journal.evidence_cutoff ?? "—"}</dd>
          <dt>Authority class</dt><dd>{journal.authority_class}</dd>
        </dl>
      ) : null}
      <p className="pd-note">
        {snapshot.evidence_boundary.beads ? <><strong>Beads:</strong> {snapshot.evidence_boundary.beads}<br /></> : null}
        {snapshot.evidence_boundary.runtime ? <><strong>Runtime:</strong> {snapshot.evidence_boundary.runtime}<br /></> : null}
        {snapshot.evidence_boundary.jira ? <><strong>Jira:</strong> {snapshot.evidence_boundary.jira}</> : null}
      </p>
      <p className="pd-muted">
        Unavailable provenance layers stay UNKNOWN: principal set, externally attested execution id, mutation receipt id,
        returned-object content binding, signer/signature.
      </p>
    </div>
  );
}

function GithubTab({ node, snapshot }: { node: ProgrammeNode; snapshot: ProgrammeSnapshot }) {
  if (!node.source_path) return <div className="pd-empty">No canonical source path recorded for this entity.</div>;
  const ref = snapshot.programme.sha ?? snapshot.programme.branch;
  const url = `https://github.com/mercuryintelligence/program/blob/${encodeURIComponent(ref)}/${node.source_path}`;
  return (
    <div className="pd-section">
      <h4>GitHub source</h4>
      <dl className="pd-dl">
        <dt>Snapshot ref</dt><dd className="pd-mono">{ref}</dd>
        <dt>Path</dt><dd className="pd-mono">{node.source_path}</dd>
      </dl>
      <a className="pd-button" href={url} target="_blank" rel="noreferrer">Open exact canonical source</a>
      <p className="pd-muted">Reads are served server-side; no GitHub credential exists in the browser.</p>
    </div>
  );
}

function MetadataTab({ node }: { node: ProgrammeNode }) {
  const entries = useMemo(() => {
    const out: Array<[string, unknown]> = [];
    const meta = node.metadata ?? {};
    for (const [key, value] of Object.entries(meta)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) out.push([`${key}.${k2}`, v2]);
      } else {
        out.push([key, value]);
      }
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]));
  }, [node]);

  return (
    <div className="pd-section">
      <h4>Metadata · {entries.length}</h4>
      {entries.length === 0 ? <div className="pd-empty">No structured metadata.</div> : (
        <div className="pd-meta-list">
          {entries.map(([key, value]) => (
            <div key={key} className="pd-meta-row">
              <div className="pd-meta-key">{key}</div>
              <div className="pd-meta-value">{formatValue(value)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(" · ");
  if (value === null || value === undefined) return "—";
  return String(value);
}
