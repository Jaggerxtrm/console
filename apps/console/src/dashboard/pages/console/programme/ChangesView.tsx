// ChangesView — exact entity-level Programme comparisons.
//
// Last visit is the browser-local exact SHA baseline supplied by
// useProgrammeChanges. 24h/7d/30d and explicit SHA modes call the server-side
// /compare endpoint and build the compared snapshots at exact source commits.
// FILE revision history remains explicitly separate from entity change history.

import { useEffect, useRef, useState } from "react";
import type {
  ProgrammeChangeSet,
  ProgrammeEntityChange,
  ProgrammeFieldChange,
  ProgrammeRelationChange,
  ProgrammeRevisionHistory,
  ProgrammeSnapshot,
  ProgrammeStatusTrailEntry,
} from "../../../../types/programme.ts";
import { fetchProgrammeCompare, fetchRevisionHistory, type ProgrammeCompareWindow } from "./useProgrammeChanges.ts";
import { useProgrammeContext } from "./context-buffer.ts";

type CompareMode = "last" | ProgrammeCompareWindow | "sha";

const MODES: Array<{ id: CompareMode; label: string }> = [
  { id: "last", label: "Last visit" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "sha", label: "SHA" },
];

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "—";
}

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toISOString().slice(0, 10);
}

function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function modeLabel(mode: CompareMode, shaInput: string): string {
  if (mode === "last") return "browser last visit";
  if (mode === "sha") return shaInput.trim() ? `explicit ${shaInput.trim()}` : "explicit SHA";
  return `${mode} baseline`;
}

export function ChangesView({
  snapshot,
  changeSet,
  loading = false,
  error = null,
  onReload,
}: {
  snapshot: ProgrammeSnapshot;
  changeSet: ProgrammeChangeSet | null;
  loading?: boolean;
  error?: string | null;
  onReload?: () => void;
}) {
  const addChange = useProgrammeContext((state) => state.addChange);
  const [mode, setMode] = useState<CompareMode>("last");
  const [shaInput, setShaInput] = useState("");
  const [historical, setHistorical] = useState<ProgrammeChangeSet | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "last") {
      setHistorical(null);
      setCompareError(null);
    }
  }, [mode, changeSet]);

  const loadWindow = async (window: ProgrammeCompareWindow) => {
    setMode(window);
    setCompareLoading(true);
    setCompareError(null);
    try {
      setHistorical(await fetchProgrammeCompare({ window, to: snapshot.programme.sha ?? undefined }));
    } catch (err) {
      setHistorical(null);
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompareLoading(false);
    }
  };

  const loadSha = async () => {
    const ref = shaInput.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      setCompareError("Enter a 7–40 character hexadecimal commit SHA.");
      return;
    }
    setMode("sha");
    setCompareLoading(true);
    setCompareError(null);
    try {
      setHistorical(await fetchProgrammeCompare({ from: ref, to: snapshot.programme.sha ?? undefined }));
    } catch (err) {
      setHistorical(null);
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompareLoading(false);
    }
  };

  const active = mode === "last" ? changeSet : historical;
  const activeLoading = mode === "last" ? loading : compareLoading;
  const activeError = mode === "last" ? error : compareError;
  const entities = active?.entities ?? [];
  const kindCount = new Set(entities.map((entity) => entity.kind)).size;

  return (
    <>
      <div className="pd-banner pd-diff-header">
        <span className="pd-muted">{modeLabel(mode, shaInput)}</span>
        {active?.previous_sha ? (
          <span className="pd-mono pd-diff-sha" title={`${active.previous_sha} → ${active.current_sha ?? ""}`}>
            {short(active.previous_sha)} → {short(active.current_sha)}
          </span>
        ) : (
          <span className="pd-muted">no earlier exact baseline observed/resolved</span>
        )}
        <span className="pd-muted">target {short(active?.current_sha ?? snapshot.programme.sha)}</span>
      </div>

      <div className="pd-filterbar">
        <button
          type="button"
          className={mode === "last" ? "pd-filter is-active" : "pd-filter"}
          onClick={() => setMode("last")}
        >
          Last visit
        </button>
        {(["24h", "7d", "30d"] as ProgrammeCompareWindow[]).map((window) => (
          <button
            key={window}
            type="button"
            className={mode === window ? "pd-filter is-active" : "pd-filter"}
            onClick={() => void loadWindow(window)}
          >
            {window}
          </button>
        ))}
        <button
          type="button"
          className={mode === "sha" ? "pd-filter is-active" : "pd-filter"}
          onClick={() => setMode("sha")}
        >
          SHA
        </button>
        {mode === "sha" ? (
          <>
            <input
              className="pd-filter-sha"
              placeholder="baseline commit SHA…"
              value={shaInput}
              onChange={(event) => setShaInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void loadSha(); }}
              aria-label="Baseline commit SHA"
            />
            <button type="button" className="pd-filter" onClick={() => void loadSha()}>Compare</button>
          </>
        ) : null}
        {mode === "last" && onReload ? <button type="button" className="pd-filter" onClick={onReload}>Re-read last visit</button> : null}
      </div>

      <div className="pd-muted pd-diff-counts">
        {activeLoading ? "Resolving exact source snapshots…" : active ? `${entities.length} entities changed across ${kindCount} kinds · ${active.relation_count} relation changes` : "No comparison loaded"}
      </div>

      {activeError ? <div className="pd-banner pd-banner-warn">{activeError}</div> : null}

      {!activeLoading && !activeError && !active ? (
        <div className="pd-muted">No change set available for this baseline.</div>
      ) : null}

      {!activeLoading && active && entities.length === 0 ? (
        <div className="pd-muted">
          {active.previous_sha ? "No entity-level changes between the exact source snapshots." : "No prior exact baseline exists for this comparison yet."}
        </div>
      ) : null}

      {!activeLoading && entities.map((entity) => (
        <section key={entity.entity_key} className="pd-panel" data-entity-key={entity.entity_key}>
          <header className="pd-panel-hd">
            <div>
              <div className="pd-panel-title"><span className="pd-mono">{entity.entity_key}</span></div>
              <div className="pd-panel-sub">{entity.title || entity.display_id} · {entity.kind}</div>
            </div>
            <div className="pd-entity-actions">
              <button
                type="button"
                className="pd-add-ctx"
                title="Add this exact ChangeSet to Context"
                onClick={() => addChange(snapshot, entity)}
              >
                Add change to context
              </button>
            </div>
          </header>
          <div className="pd-panel-body">
            <FieldChanges fields={entity.field_changes} />
            <RelationChanges relations={entity.relation_changes} />
            <StatusTrail trail={entity.status_trail} />
            {entity.path ? <RevisionsSection path={entity.path} entityKey={entity.entity_key} /> : null}
          </div>
        </section>
      ))}
    </>
  );
}

/** Deterministic field diff — server order preserved. */
export function FieldChanges({ fields }: { fields: ProgrammeFieldChange[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="pd-diff-block">
      <div className="pd-diff-hd">Field changes · {fields.length}</div>
      <div className="pd-diff-table">
        {fields.map((field, index) => (
          <div key={`${field.field}-${index}`} className="pd-diff-row">
            <span className="pd-mono pd-diff-field">{field.field}</span>
            <span className={`pd-diff-kind pd-diff-kind-${field.kind}`}>{field.kind}</span>
            <span className="pd-diff-prev">{fmtValue(field.previous)}</span>
            <span className="pd-diff-arrow">→</span>
            <span className="pd-diff-cur">{fmtValue(field.current)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Added and removed relations rendered separately, never semantically merged. */
export function RelationChanges({ relations }: { relations: ProgrammeRelationChange[] }) {
  const added = relations.filter((relation) => relation.kind === "added");
  const removed = relations.filter((relation) => relation.kind === "removed");
  if (added.length === 0 && removed.length === 0) return null;
  const rows = (items: ProgrammeRelationChange[], prefix: string) => items.map((relation, index) => (
    <div key={`${prefix}-${relation.source}-${relation.target}-${relation.relation}-${relation.field}-${index}`} className="pd-rel-row">
      <span className="pd-mono">{relation.source}</span>
      <span className="pd-rel-arrow">→</span>
      <span className="pd-rel-name">{relation.relation}</span>
      <span className="pd-rel-arrow">→</span>
      <span className="pd-mono">{relation.target}</span>
      <span className="pd-rel-field">{relation.field} · {relation.strength}</span>
    </div>
  ));
  return (
    <div className="pd-diff-block">
      {added.length > 0 ? <div className="pd-rel-group pd-rel-added"><div className="pd-diff-hd">Added relations · {added.length}</div>{rows(added, "add")}</div> : null}
      {removed.length > 0 ? <div className="pd-rel-group pd-rel-removed"><div className="pd-diff-hd">Removed relations · {removed.length}</div>{rows(removed, "remove")}</div> : null}
    </div>
  );
}

/** Observed status transitions only — never derived/synthetic states. */
export function StatusTrail({ trail }: { trail: ProgrammeStatusTrailEntry[] }) {
  if (trail.length === 0) return null;
  return (
    <div className="pd-diff-block">
      <div className="pd-diff-hd">Status trail <span className="pd-trail-label">observed states only</span></div>
      <div className="pd-trail">
        {trail.map((entry, index) => (
          <div key={`${entry.sha ?? ""}-${entry.date}-${index}`} className="pd-trail-entry">
            <span className="pd-trail-dot" />
            <span className="pd-trail-date">{fmtDate(entry.date)}</span>
            <span className="pd-trail-sep">·</span>
            <span className="pd-trail-status">{entry.status ?? "—"}</span>
            {entry.sha ? <><span className="pd-trail-sep">·</span><span className="pd-mono pd-trail-sha">{entry.sha.slice(0, 7)}</span></> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** FILE-level commit history for one canonical source path. */
export function RevisionHistoryBody({ history }: { history: ProgrammeRevisionHistory }) {
  return (
    <div>
      <div className="pd-rev-current">
        source-file commits: <span className="pd-mono">{short(history.previous_revision_sha)} → {short(history.current_revision_sha)}</span>
      </div>
      <div className="pd-muted">These are commits touching the source file, not automatically entity-level changes.</div>
      {history.revisions.length === 0 ? (
        <div className="pd-muted">No source-file revisions recorded.</div>
      ) : (
        <div className="pd-rev-list">
          {history.revisions.map((revision) => (
            <div key={revision.sha} className="pd-rev-row">
              <span className="pd-mono pd-rev-sha">{revision.sha.slice(0, 7)}</span>
              <span className="pd-rev-date">{fmtDate(revision.date)}</span>
              <span className="pd-rev-subject">{revision.subject}</span>
              <a className="pd-link" href={revision.url} target="_blank" rel="noreferrer">Open</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RevisionsSection({ path, entityKey }: { path: string; entityKey: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ProgrammeRevisionHistory | null | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => {
    if (!open || history !== undefined || started.current) return;
    started.current = true;
    void fetchRevisionHistory(path, entityKey).then(setHistory);
  }, [open, history, path, entityKey]);

  return (
    <div className="pd-diff-block">
      <button type="button" className={open ? "pd-rev-toggle is-open" : "pd-rev-toggle"} onClick={() => setOpen((value) => !value)}>
        Source-file history · <span className="pd-mono">{path}</span>
      </button>
      {open ? (
        history === undefined ? <div className="pd-muted pd-rev-loading">Loading source-file commits…</div>
          : history === null ? <div className="pd-muted">No source-file history available.</div>
            : <RevisionHistoryBody history={history} />
      ) : null}
    </div>
  );
}
