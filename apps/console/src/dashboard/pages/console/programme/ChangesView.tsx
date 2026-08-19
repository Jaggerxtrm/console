// ChangesView — entity-level diff between the two most recently observed
// programme snapshots (the "Last visit" change set). Renders per-entity change
// records: deterministic field changes, added/removed relations (never merged),
// observed status trails, and FILE-level revision history for canonical source
// paths. Time-window filters are client-side. Factual counts only — no
// synthetic completion percentages for assignments or workstreams.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProgrammeChangeSet,
  ProgrammeEntityChange,
  ProgrammeFieldChange,
  ProgrammeRelationChange,
  ProgrammeRevisionHistory,
  ProgrammeSnapshot,
  ProgrammeStatusTrailEntry,
} from "../../../../types/programme.ts";
import { fetchRevisionHistory } from "./useProgrammeChanges.ts";
import { useProgrammeContext } from "./context-buffer.ts";

type TimeWindow = "last" | "24h" | "7d" | "30d" | "sha";

const WINDOW_LABELS: Array<{ id: TimeWindow; label: string }> = [
  { id: "last", label: "Last visit" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "sha", label: "SHA" },
];

const WINDOW_MS: Record<"24h" | "7d" | "30d", number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "—";
}

function fmtDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.valueOf())) return String(value);
  return d.toISOString().slice(0, 10);
}

function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** SHA-prefix match against observed status-trail shas or loaded revisions. */
function matchesShaPrefix(entity: ProgrammeEntityChange, prefix: string, history: ProgrammeRevisionHistory | undefined): boolean {
  const q = prefix.toLowerCase();
  if (entity.status_trail.some((t) => t.sha && t.sha.toLowerCase().startsWith(q))) return true;
  if (history?.revisions.some((r) => r.sha.toLowerCase().startsWith(q))) return true;
  return false;
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
  const addNode = useProgrammeContext((s) => s.addNode);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("last");
  const [shaInput, setShaInput] = useState("");
  const [revisions, setRevisions] = useState<Record<string, ProgrammeRevisionHistory>>({});

  const entities = changeSet?.entities ?? [];

  const filtered = useMemo(() => {
    if (timeWindow === "last") return entities;
    if (timeWindow === "sha") {
      const q = shaInput.trim();
      if (!q) return entities;
      return entities.filter((e) => matchesShaPrefix(e, q, revisions[e.entity_key]));
    }
    const cutoff = Date.now() - WINDOW_MS[timeWindow];
    return entities.filter((e) => e.status_trail.some((t) => t.date && new Date(t.date).valueOf() >= cutoff));
  }, [timeWindow, shaInput, entities, revisions]);

  const kindCount = new Set(filtered.map((e) => e.kind)).size;

  if (loading && !changeSet) return <div className="pd-loading">Loading change set…</div>;
  if (error && !changeSet) {
    return (
      <div className="pd-error">
        <div>{error}</div>
        {onReload ? <button type="button" className="pd-button" onClick={onReload}>Retry</button> : null}
      </div>
    );
  }
  if (!changeSet) return <div className="pd-muted">No change set available.</div>;

  return (
    <>
      <div className="pd-banner pd-diff-header">
        {changeSet.previous_sha ? (
          <>
            <span className="pd-muted">current vs previous meaningful revision</span>
            <span className="pd-mono pd-diff-sha" title={`${changeSet.previous_sha} → ${changeSet.current_sha ?? ""}`}>
              {short(changeSet.previous_sha)} → {short(changeSet.current_sha)}
            </span>
          </>
        ) : (
          <span>first observation — no previous revision</span>
        )}
        <span className="pd-muted">generated {fmtDate(changeSet.generated_at)}</span>
      </div>

      <div className="pd-filterbar">
        {WINDOW_LABELS.map((w) => (
          <button
            key={w.id}
            type="button"
            className={timeWindow === w.id ? "pd-filter is-active" : "pd-filter"}
            onClick={() => setTimeWindow(w.id)}
          >
            {w.label}
          </button>
        ))}
        {timeWindow === "sha" ? (
          <input
            className="pd-filter-sha"
            placeholder="SHA prefix…"
            value={shaInput}
            onChange={(e) => setShaInput(e.target.value)}
            aria-label="SHA filter"
          />
        ) : null}
        <span className="pd-muted">{filtered.length} / {entities.length} entities</span>
      </div>

      <div className="pd-muted pd-diff-counts">{filtered.length} entities changed across {kindCount} kinds</div>

      {entities.length === 0 ? (
        <div className="pd-muted">No recorded changes in the last visit.</div>
      ) : filtered.length === 0 ? (
        <div className="pd-muted">
          {timeWindow === "sha" && shaInput.trim() ? <>No entities match {shaInput.trim()}</> : <>No entities match the current filter.</>}
        </div>
      ) : (
        filtered.map((entity) => {
          const node = snapshot.graph.nodes.find((n) => n.id === entity.entity_key) ?? null;
          return (
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
                    disabled={!node}
                    title={node ? "Add to context buffer" : "no graph node for this entity key"}
                    onClick={() => { if (node) addNode(snapshot, node, { source_view: "diff" }); }}
                  >
                    Add to context
                  </button>
                </div>
              </header>
              <div className="pd-panel-body">
                <FieldChanges fields={entity.field_changes} />
                <RelationChanges relations={entity.relation_changes} />
                <StatusTrail trail={entity.status_trail} />
                {entity.path ? (
                  <RevisionsSection
                    path={entity.path}
                    history={revisions[entity.entity_key]}
                    onLoaded={(h) => setRevisions((m) => ({ ...m, [entity.entity_key]: h }))}
                  />
                ) : null}
              </div>
            </section>
          );
        })
      )}
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
        {fields.map((f, i) => (
          <div key={`${f.field}-${i}`} className="pd-diff-row">
            <span className="pd-mono pd-diff-field">{f.field}</span>
            <span className={`pd-diff-kind pd-diff-kind-${f.kind}`}>{f.kind}</span>
            <span className="pd-diff-prev">{fmtValue(f.previous)}</span>
            <span className="pd-diff-arrow">→</span>
            <span className="pd-diff-cur">{fmtValue(f.current)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Added and removed relations rendered as two separate groups, never merged. */
export function RelationChanges({ relations }: { relations: ProgrammeRelationChange[] }) {
  const added = relations.filter((r) => r.kind === "added");
  const removed = relations.filter((r) => r.kind === "removed");
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="pd-diff-block">
      {added.length > 0 ? (
        <div className="pd-rel-group pd-rel-added">
          <div className="pd-diff-hd">Added relations · {added.length}</div>
          {added.map((r, i) => (
            <div key={`add-${r.source}-${r.target}-${r.relation}-${r.field}-${i}`} className="pd-rel-row">
              <span className="pd-mono">{r.source}</span>
              <span className="pd-rel-arrow">→</span>
              <span className="pd-rel-name">{r.relation}</span>
              <span className="pd-rel-arrow">→</span>
              <span className="pd-mono">{r.target}</span>
              <span className="pd-rel-field">{r.field}</span>
            </div>
          ))}
        </div>
      ) : null}
      {removed.length > 0 ? (
        <div className="pd-rel-group pd-rel-removed">
          <div className="pd-diff-hd">Removed relations · {removed.length}</div>
          {removed.map((r, i) => (
            <div key={`rem-${r.source}-${r.target}-${r.relation}-${r.field}-${i}`} className="pd-rel-row">
              <span className="pd-mono">{r.source}</span>
              <span className="pd-rel-arrow">→</span>
              <span className="pd-rel-name">{r.relation}</span>
              <span className="pd-rel-arrow">→</span>
              <span className="pd-mono">{r.target}</span>
              <span className="pd-rel-field">{r.field}</span>
            </div>
          ))}
        </div>
      ) : null}
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
        {trail.map((t, i) => (
          <div key={`${t.sha ?? ""}-${t.date}-${i}`} className="pd-trail-entry">
            <span className="pd-trail-dot" />
            <span className="pd-trail-date">{fmtDate(t.date)}</span>
            <span className="pd-trail-sep">·</span>
            <span className="pd-trail-status">{t.status ?? "—"}</span>
            {t.sha ? <><span className="pd-trail-sep">·</span><span className="pd-mono pd-trail-sha">{t.sha.slice(0, 7)}</span></> : null}
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
        current vs previous: <span className="pd-mono">{short(history.previous_revision_sha)} → {short(history.current_revision_sha)}</span>
      </div>
      {history.revisions.length === 0 ? (
        <div className="pd-muted">No revisions recorded for this path.</div>
      ) : (
        <div className="pd-rev-list">
          {history.revisions.map((r) => (
            <div key={r.sha} className="pd-rev-row">
              <span className="pd-mono pd-rev-sha">{r.sha.slice(0, 7)}</span>
              <span className="pd-rev-date">{fmtDate(r.date)}</span>
              <span className="pd-rev-subject">{r.subject}</span>
              <a className="pd-link" href={r.url} target="_blank" rel="noreferrer">Open</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lazily fetched (on expand) FILE-level revision history for a source path. */
export function RevisionsSection({
  path,
  history,
  onLoaded,
}: {
  path: string;
  history: ProgrammeRevisionHistory | null | undefined;
  onLoaded: (history: ProgrammeRevisionHistory) => void;
}) {
  const [open, setOpen] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (open && history === undefined && !started.current) {
      started.current = true;
      void fetchRevisionHistory(path).then((h) => { if (h) onLoaded(h); });
    }
  }, [open, history, path, onLoaded]);

  return (
    <div className="pd-diff-block">
      <button type="button" className={open ? "pd-rev-toggle is-open" : "pd-rev-toggle"} onClick={() => setOpen((o) => !o)}>
        Revisions — FILE-level revision history for <span className="pd-mono">{path}</span>
      </button>
      {open ? (
        history === undefined ? <div className="pd-muted pd-rev-loading">Loading revisions…</div>
        : history === null ? <div className="pd-muted">No revision history available.</div>
        : <RevisionHistoryBody history={history} />
      ) : null}
    </div>
  );
}
