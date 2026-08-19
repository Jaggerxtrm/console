// /console/programme — Context Buffer UI (EXP-020).
// Cross-view, session-only selection memory. Self-contained: the active view
// is derived from the URL path, which Programme.tsx keeps in sync via
// history.replaceState, so the buffer can be mounted once next to the entity
// drawer and stays mounted across all programme views.
//
// Entries are addressed by collision-safe `entity_key` (the graph node id —
// never kind+display_id alone). Selected paths, selection groups and the
// selected/derived relation split are preserved. Everything is client-side;
// no server endpoints are involved.

import { useEffect, useRef, useState } from "react";
import type { ProgrammeSnapshot } from "../../../../types/programme.ts";
import { resolveRecord } from "./identity.ts";
import { useProgrammeContext } from "./context-buffer.ts";
import type { ContextDensity, ContextEntry, ContextRelationRef, ContextSourceView } from "./context-buffer.ts";

const MAX_ADD_PER_CALL = 50;

/** A view record that can be resolved to a collision-safe entity key. */
interface ViewRecord {
  id: string;
  kind: string;
  path?: string | null;
  title: string;
}

/** Map a capture source to the records it snapshots. `graph` and `diff` add
 * context through their own selection mechanisms — no records here. */
const VIEW_RECORDS: Record<ContextSourceView, (s: ProgrammeSnapshot) => ViewRecord[]> = {
  graph: () => [],
  diff: () => [],
  workstreams: (s) => (s.workstreams ?? []).map((r) => ({ id: r.graph_id ?? r.id, kind: "workstream", path: r.path, title: r.title })),
  assignments: (s) => (s.assignments ?? []).map((r) => ({ id: r.graph_id ?? r.id, kind: "assignment", path: r.path, title: r.title })),
  state: (s) => (s.state_records ?? []).map((r) => ({ id: r.id, kind: "state", path: r.path, title: r.title })),
  journals: (s) => (s.journals ?? []).map((r) => ({ id: r.id, kind: "journal", path: r.path, title: r.title })),
  adr: (s) => (s.decisions ?? []).map((r) => ({ id: r.graph_id ?? r.id, kind: "decision", path: r.path, title: r.title })),
  research: (s) => [...(s.research ?? []), ...(s.proposals ?? [])].map((r) => ({ id: r.graph_id ?? r.id, kind: r.kind, path: r.path, title: r.title })),
  agents: (s) => (s.agents ?? []).map((r) => ({ id: r.graph_id ?? r.id, kind: "actor", path: r.path, title: r.title })),
  jira: (s) => (s.jira_refs ?? []).map((r) => ({ id: r.key, kind: "jira_ref", path: null, title: `Jira reference ${r.key}` })),
  explore: (s) => exploreRecords(s),
};

/** Programme.tsx view ids → capture sources. Views without a mapping (overview,
 * revenue, identity, activity, sourcehealth) capture nothing. */
const PATH_VIEWS: Record<string, ContextSourceView[]> = {
  workstreams: ["workstreams"],
  assignments: ["assignments"],
  explore: ["explore"],
  jira: ["jira"],
  agents: ["agents"],
  statejournal: ["state", "journals"],
  knowledge: ["research", "adr"],
  graph: ["graph"],
};

const DENSITIES: Array<{ id: ContextDensity; label: string }> = [
  { id: "compact", label: "Compact" },
  { id: "standard", label: "Standard" },
  { id: "full", label: "Full" },
];

/** Explore-view style aggregation, reduced to identity-resolvable records. */
function exploreRecords(s: ProgrammeSnapshot): ViewRecord[] {
  const out: ViewRecord[] = [];
  for (const w of s.workstreams ?? []) out.push({ id: w.graph_id ?? w.id, kind: "workstream", path: w.path, title: w.title });
  for (const a of s.assignments ?? []) out.push({ id: a.graph_id ?? a.id, kind: "assignment", path: a.path, title: a.title });
  for (const r of s.research ?? []) out.push({ id: r.graph_id ?? r.id, kind: "research", path: r.path, title: r.title });
  for (const d of s.decisions ?? []) out.push({ id: d.graph_id ?? d.id, kind: "decision", path: d.path, title: d.title });
  for (const p of s.proposals ?? []) out.push({ id: p.graph_id ?? p.id, kind: "proposal", path: p.path, title: p.title });
  for (const st of s.state_records ?? []) out.push({ id: st.id, kind: "state", path: st.path, title: st.title });
  for (const j of s.journals ?? []) out.push({ id: j.id, kind: "journal", path: j.path, title: j.title });
  for (const pub of s.publication_facts ?? []) out.push({ id: pub.id, kind: "publication", path: pub.source_path, title: pub.title });
  return out;
}

function currentViewFromPath(): ContextSourceView[] {
  const path = window.location.pathname;
  for (const [id, views] of Object.entries(PATH_VIEWS)) {
    if (path.includes(`/programme/${id}`)) return views;
  }
  return [];
}

function entryFor(snapshot: ProgrammeSnapshot, rec: ViewRecord, view: ContextSourceView): Omit<ContextEntry, "captured_at"> | null {
  const keyed = resolveRecord(snapshot, rec);
  if (!keyed) return null;
  return {
    entity_key: keyed.key,
    display_id: keyed.displayId,
    kind: keyed.kind,
    title: rec.title || keyed.displayId,
    path: keyed.path,
    source_sha: snapshot.programme.sha ?? null,
    source_view: view,
    selected_path: null,
    group: null,
    selected_relations: [],
    derived_relations: [],
    evidence_boundary: snapshot.evidence_boundary ?? {},
  };
}

function addCaptureGroups(snapshot: ProgrammeSnapshot, groups: Array<{ view: ContextSourceView; records: ViewRecord[] }>): number {
  const store = useProgrammeContext.getState();
  const seen = new Set<string>();
  let added = 0;
  for (const { view, records } of groups) {
    for (const rec of records) {
      if (added >= MAX_ADD_PER_CALL) return added;
      const entry = entryFor(snapshot, rec, view);
      if (!entry || seen.has(entry.entity_key)) continue;
      seen.add(entry.entity_key);
      store.add(entry);
      added += 1;
    }
  }
  return added;
}

/** Capture the records of one programme view into the context buffer. Returns
 * the number of entries added. `graph` and `diff` return 0 (they add context
 * through their own selection mechanisms). */
export function addViewContext(snapshot: ProgrammeSnapshot, view: ContextSourceView): number {
  return addCaptureGroups(snapshot, [{ view, records: VIEW_RECORDS[view]?.(snapshot) ?? [] }]);
}

/** UNKNOWN stays UNKNOWN — never invent a value for missing data. */
function display(value: unknown): string {
  if (value === null || value === undefined) return "UNKNOWN";
  const s = String(value);
  return s.trim() === "" || s === "UNKNOWN" ? "UNKNOWN" : s;
}

function relationLine(entry: ContextEntry, r: ContextRelationRef): string {
  const outbound = r.source === entry.entity_key;
  return `${r.source} ${outbound ? "→" : "←"} ${r.target} (${r.relation}/${r.field}) [${r.strength}]`;
}

function refsText(entries: ContextEntry[]): string {
  return entries
    .map((e) => (e.path ? `${e.display_id} (${e.path})` : e.display_id))
    .join("\n");
}

function contextText(entries: ContextEntry[]): string {
  return entries.map((e) => {
    const lines = [
      e.display_id,
      `  entity_key: ${e.entity_key}`,
      `  kind: ${e.kind}`,
      `  title: ${display(e.title)}`,
      `  source view: ${e.source_view}`,
      `  selected path: ${display(e.selected_path)}`,
      `  group: ${display(e.group)}`,
      `  source sha: ${display(e.source_sha)}`,
      "  selected relations:",
    ];
    if (e.selected_relations.length === 0) lines.push("    (none)");
    else for (const r of e.selected_relations) lines.push(`    - ${relationLine(e, r)}`);
    lines.push("  derived relations:");
    if (e.derived_relations.length === 0) lines.push("    (none)");
    else for (const r of e.derived_relations) lines.push(`    - ${relationLine(e, r)}`);
    lines.push("  evidence boundary:");
    const boundary = e.evidence_boundary ?? {};
    if (Object.keys(boundary).length === 0) lines.push("    (none)");
    else for (const [k, v] of Object.entries(boundary)) lines.push(`    ${k}: ${display(v)}`);
    return lines.join("\n");
  }).join("\n\n");
}

/** navigator.clipboard with a textarea + execCommand fallback. */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to the textarea fallback */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

function FullDetail({ entry }: { entry: ContextEntry }) {
  const boundary = entry.evidence_boundary ?? {};
  return (
    <div className="pg-buffer-full">
      <div className="pg-buffer-rel-group">
        <div className="pg-buffer-rel-group-label">Selected relations</div>
        {entry.selected_relations.length === 0
          ? <div className="pg-buffer-muted">none</div>
          : entry.selected_relations.map((r) => <div key={r.key} className="pg-buffer-rel">{relationLine(entry, r)}</div>)}
      </div>
      <div className="pg-buffer-rel-group">
        <div className="pg-buffer-rel-group-label">Derived relations</div>
        {entry.derived_relations.length === 0
          ? <div className="pg-buffer-muted">none</div>
          : entry.derived_relations.map((r) => <div key={r.key} className="pg-buffer-rel">{relationLine(entry, r)}</div>)}
      </div>
      <div className="pg-buffer-rel-group">
        <div className="pg-buffer-rel-group-label">Evidence boundary</div>
        {Object.keys(boundary).length === 0
          ? <div className="pg-buffer-muted">none recorded</div>
          : Object.entries(boundary).map(([k, v]) => (
            <div key={k} className="pg-buffer-boundary-row"><span>{k}</span><span>{display(v)}</span></div>
          ))}
      </div>
      <div className="pg-buffer-meta-row">source sha: {display(entry.source_sha)}</div>
      <div className="pg-buffer-meta-row">captured at: {display(entry.captured_at)}</div>
    </div>
  );
}

function EntryRow({ entry, density, onRemove }: { entry: ContextEntry; density: ContextDensity; onRemove: (key: string) => void }) {
  const relCount = entry.selected_relations.length + entry.derived_relations.length;
  return (
    <li className={`pg-buffer-entry pg-buffer-entry-${density}`} data-entity-key={entry.entity_key}>
      <div className="pg-buffer-entry-hd">
        <span className="pg-buffer-kind-dot" aria-hidden="true" />
        <span className="pg-buffer-entry-id">{entry.display_id}</span>
        <span className="pg-buffer-entry-meta">{entry.kind}</span>
        <span className="pg-buffer-rel-count">{relCount} rel</span>
        <button type="button" className="pg-buffer-remove" title="Remove from context" onClick={() => onRemove(entry.entity_key)}>×</button>
      </div>
      {density !== "compact" ? (
        <>
          {entry.title ? <div className="pg-buffer-entry-title">{entry.title}</div> : null}
          <div className="pg-buffer-entry-sub">
            <span>{entry.source_view}</span>
            {entry.path ? <span className="pg-buffer-path">{entry.path}</span> : null}
            <span className="pg-buffer-sha">{display(entry.source_sha)}</span>
          </div>
          {entry.selected_path ? <div className="pg-buffer-selected-path">selected path: {entry.selected_path}</div> : null}
          {entry.group ? <span className="pg-buffer-group-tag">{entry.group}</span> : null}
          {density === "full" ? <FullDetail entry={entry} /> : null}
        </>
      ) : null}
    </li>
  );
}

/** Persistent, cross-view context buffer. Collapsed = a small "Context (N)"
 * tab; expanded = a fixed bottom-right panel. */
export function ContextBuffer({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const entries = useProgrammeContext((s) => s.entries);
  const density = useProgrammeContext((s) => s.density);
  const setDensity = useProgrammeContext((s) => s.setDensity);
  const remove = useProgrammeContext((s) => s.remove);
  const clear = useProgrammeContext((s) => s.clear);

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current); }, []);

  const activeViews = currentViewFromPath();
  const canAdd = activeViews.some((v) => VIEW_RECORDS[v](snapshot).length > 0);

  const capture = () => {
    addCaptureGroups(snapshot, currentViewFromPath().map((v) => ({ view: v, records: VIEW_RECORDS[v](snapshot) })));
  };

  const copy = (text: string, label: string) => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    setCopied(label);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    void writeClipboard(text);
  };

  if (!open) {
    return (
      <button type="button" className="pg-buffer-tab" title="Expand context buffer" onClick={() => setOpen(true)}>
        Context ({entries.length})
      </button>
    );
  }

  return (
    <aside className="pg-buffer" aria-label="Programme context buffer">
      <header className="pg-buffer-hd">
        <span className="pg-buffer-title">Context buffer</span>
        <span className="pg-buffer-count">{entries.length}</span>
        <button type="button" className="pg-buffer-btn" title="Add current view to context" onClick={capture} disabled={!canAdd}>+</button>
        <div className="pg-buffer-dens" role="group" aria-label="Display density">
          {DENSITIES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={density === d.id ? "pg-buffer-dens-btn is-active" : "pg-buffer-dens-btn"}
              onClick={() => setDensity(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <button type="button" className="pg-buffer-btn" title="Copy refs" onClick={() => copy(refsText(entries), "refs")} disabled={entries.length === 0}>Copy refs</button>
        <button type="button" className="pg-buffer-btn" title="Copy context" onClick={() => copy(contextText(entries), "context")} disabled={entries.length === 0}>Copy context</button>
        <button type="button" className="pg-buffer-btn" title="Copy JSON" onClick={() => copy(JSON.stringify(entries, null, 2), "json")} disabled={entries.length === 0}>Copy JSON</button>
        <button type="button" className="pg-buffer-btn" title="Clear all" onClick={clear} disabled={entries.length === 0}>Clear all</button>
        <button type="button" className="pg-buffer-btn" title="Collapse context buffer" onClick={() => setOpen(false)}>×</button>
      </header>
      {copied ? <div className="pg-buffer-copied" role="status">Copied</div> : null}
      <ul className="pg-buffer-list">
        {entries.length === 0 ? <li className="pg-buffer-empty">Nothing captured yet. Use “+” to capture the current view.</li> : null}
        {entries.map((e) => <EntryRow key={e.entity_key} entry={e} density={density} onRemove={remove} />)}
      </ul>
    </aside>
  );
}
