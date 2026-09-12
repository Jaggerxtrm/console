// Programme Context — cross-view, session-only agent context bundle.
//
// The floating tray never becomes programme memory or a second datastore. It
// contains only the read-model data the operator explicitly selected. Entity
// identity is collision-safe, selection groups and relation provenance survive
// deduplication, and copied bundles retain exact source/evidence boundaries.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProgrammeSnapshot } from "../../../../types/programme.ts";
import { resolveRecord } from "./identity.ts";
import {
  contextDraftForNode,
  useProgrammeContext,
  type ContextDensity,
  type ContextEntry,
  type ContextRelationRef,
  type ContextSelectionGroup,
  type ContextSourceView,
} from "./context-buffer.ts";

const MAX_PICKER_RECORDS = 300;

interface ViewRecord {
  id: string;
  kind: string;
  path?: string | null;
  title: string;
}

const VIEW_RECORDS: Record<ContextSourceView, (snapshot: ProgrammeSnapshot) => ViewRecord[]> = {
  graph: () => [],
  diff: () => [],
  workstreams: (snapshot) => (snapshot.workstreams ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "workstream", path: record.path, title: record.title })),
  assignments: (snapshot) => (snapshot.assignments ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "assignment", path: record.path, title: record.title })),
  state: (snapshot) => (snapshot.state_records ?? []).map((record) => ({ id: record.id, kind: "state", path: record.path, title: record.title })),
  journals: (snapshot) => (snapshot.journals ?? []).map((record) => ({ id: record.id, kind: "journal", path: record.path, title: record.title })),
  adr: (snapshot) => (snapshot.decisions ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "decision", path: record.path, title: record.title })),
  research: (snapshot) => [
    ...(snapshot.research ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "research", path: record.path, title: record.title })),
    ...(snapshot.proposals ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "proposal", path: record.path, title: record.title })),
  ],
  agents: (snapshot) => (snapshot.agents ?? []).map((record) => ({ id: record.graph_id ?? record.id, kind: "actor", path: record.path, title: record.title })),
  jira: (snapshot) => (snapshot.jira_refs ?? []).map((record) => ({ id: record.key, kind: "jira", path: null, title: `Jira reference ${record.key}` })),
  explore: (snapshot) => exploreRecords(snapshot),
};

const PATH_VIEWS: Record<string, ContextSourceView[]> = {
  workstreams: ["workstreams"],
  assignments: ["assignments"],
  explore: ["explore"],
  jira: ["jira"],
  agents: ["agents"],
  statejournal: ["state", "journals"],
  knowledge: ["research", "adr"],
  graph: ["graph"],
  changes: ["diff"],
};

const DENSITIES: Array<{ id: ContextDensity; label: string }> = [
  { id: "compact", label: "Compact" },
  { id: "standard", label: "Standard" },
  { id: "full", label: "Full" },
];

export interface ProgrammeContextBundle {
  schema_version: "mercury.programme.context.v1";
  generated_at: string;
  programme: {
    repository: string;
    branch: string;
    sha: string | null;
    evidence_cutoff: string | null;
  };
  objects: ContextEntry[];
  relations: ContextRelationRef[];
  groups: ContextSelectionGroup[];
  evidence_boundary: Record<string, string>;
}

function exploreRecords(snapshot: ProgrammeSnapshot): ViewRecord[] {
  return [
    ...VIEW_RECORDS.workstreams(snapshot),
    ...VIEW_RECORDS.assignments(snapshot),
    ...VIEW_RECORDS.research(snapshot),
    ...VIEW_RECORDS.adr(snapshot),
    ...VIEW_RECORDS.state(snapshot),
    ...VIEW_RECORDS.journals(snapshot),
    ...(snapshot.publication_facts ?? []).map((record) => ({ id: record.id, kind: "publication", path: record.source_path, title: record.title })),
  ];
}

function currentViewsFromPath(): ContextSourceView[] {
  const path = window.location.pathname;
  for (const [id, views] of Object.entries(PATH_VIEWS)) {
    if (path.includes(`/programme/${id}`)) return views;
  }
  return [];
}

function candidateFor(snapshot: ProgrammeSnapshot, record: ViewRecord, view: ContextSourceView): { key: string; label: string; draft: ReturnType<typeof contextDraftForNode> } | null {
  const keyed = resolveRecord(snapshot, record);
  if (!keyed) return null;
  const node = snapshot.graph.nodes.find((candidate) => candidate.id === keyed.key);
  if (!node) return null;
  return {
    key: keyed.key,
    label: `${keyed.displayId} — ${record.title || keyed.displayId}`,
    draft: contextDraftForNode(snapshot, node, { source_view: view }),
  };
}

function candidatesForCurrentView(snapshot: ProgrammeSnapshot) {
  const out: Array<{ key: string; label: string; draft: ReturnType<typeof contextDraftForNode> }> = [];
  const seen = new Set<string>();
  for (const view of currentViewsFromPath()) {
    for (const record of VIEW_RECORDS[view](snapshot)) {
      const candidate = candidateFor(snapshot, record, view);
      if (!candidate || seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      out.push(candidate);
      if (out.length >= MAX_PICKER_RECORDS) return out;
    }
  }
  return out;
}

/** Test/utility helper: capture the whole supplied view as one explicit
 * visible-selection group. The normal UI uses the selection picker instead. */
export function addViewContext(snapshot: ProgrammeSnapshot, view: ContextSourceView): number {
  const drafts = VIEW_RECORDS[view](snapshot)
    .map((record) => candidateFor(snapshot, record, view))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .slice(0, MAX_PICKER_RECORDS)
    .map((value) => value.draft);
  if (drafts.length === 0) return 0;
  useProgrammeContext.getState().addMany(drafts, { kind: "visible_selection", label: `${view} visible selection` });
  return drafts.length;
}

function allRelations(entries: ContextEntry[]): ContextRelationRef[] {
  const selected = new Map<string, ContextRelationRef>();
  const derived = new Map<string, ContextRelationRef>();
  for (const entry of entries) {
    for (const relation of entry.selected_relations) selected.set(relation.key, { ...relation, selected: true });
    for (const relation of entry.derived_relations) if (!selected.has(relation.key)) derived.set(relation.key, { ...relation, selected: false });
  }
  for (const key of selected.keys()) derived.delete(key);
  return [...selected.values(), ...derived.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function buildContextBundle(
  snapshot: ProgrammeSnapshot,
  entries: ContextEntry[],
  groups: ContextSelectionGroup[],
): ProgrammeContextBundle {
  const selectedKeys = new Set(entries.map((entry) => entry.entity_key));
  const relevantGroups = groups
    .map((group) => ({
      ...group,
      entity_keys: group.entity_keys.filter((key) => selectedKeys.has(key)),
      relation_keys: group.relation_keys.filter((key) => allRelations(entries).some((relation) => relation.key === key)),
    }))
    .filter((group) => group.entity_keys.length > 0 || group.relation_keys.length > 0);
  return {
    schema_version: "mercury.programme.context.v1",
    generated_at: new Date().toISOString(),
    programme: {
      repository: snapshot.programme.repository,
      branch: snapshot.programme.branch,
      sha: snapshot.programme.sha ?? null,
      evidence_cutoff: snapshot.now?.evidence_cutoff ?? null,
    },
    objects: entries,
    relations: allRelations(entries),
    groups: relevantGroups,
    evidence_boundary: snapshot.evidence_boundary ?? {},
  };
}

function sourceRef(entry: ContextEntry): string {
  const ref = entry.source_sha ?? entry.source_branch ?? "UNKNOWN";
  return `${entry.source_repository}@${ref}${entry.path ? `/${entry.path}` : ""}`;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "UNKNOWN";
  return String(value);
}

export function serializeContextRefs(bundle: ProgrammeContextBundle): string {
  return [
    "MERCURY PROGRAMME REFERENCES",
    `Snapshot: ${bundle.programme.repository}@${bundle.programme.sha ?? bundle.programme.branch}`,
    `Evidence cutoff: ${display(bundle.programme.evidence_cutoff)}`,
    "",
    ...bundle.objects.flatMap((entry) => [entry.display_id, `  ${sourceRef(entry)}`, `  entity_key: ${entry.entity_key}`]),
  ].join("\n");
}

function metadataLines(entry: ContextEntry, density: ContextDensity): string[] {
  if (density === "compact") return [];
  const lines = [
    `  status: ${display(entry.status)}`,
    `  authority: ${display(entry.authority)}`,
    `  evidence: ${display(entry.evidence_class)}`,
    `  freshness: ${display(entry.freshness)}`,
  ];
  if (density === "full") {
    for (const [key, value] of Object.entries(entry.metadata ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const rendered = typeof value === "object" ? JSON.stringify(value) : display(value);
      lines.push(`  metadata.${key}: ${rendered}`);
    }
  }
  return lines;
}

function changeLines(entry: ContextEntry): string[] {
  const change = entry.change;
  if (!change) return [];
  const out = [
    `  compare: ${display(change.previous_revision_sha)} -> ${display(change.current_revision_sha)}`,
    `  field_changes: ${change.field_changes.length}`,
  ];
  for (const field of change.field_changes) {
    out.push(`    - ${field.field}: ${field.kind} ${display(field.previous)} -> ${display(field.current)}`);
  }
  out.push(`  relation_changes: ${change.relation_changes.length}`);
  for (const relation of change.relation_changes) {
    out.push(`    - ${relation.kind} ${relation.source} -> ${relation.target} ${relation.relation} [${relation.strength}] field=${relation.field}`);
  }
  return out;
}

export function serializeContextBundle(bundle: ProgrammeContextBundle, density: ContextDensity = "standard"): string {
  const lines = [
    "MERCURY PROGRAMME CONTEXT",
    `Snapshot: ${bundle.programme.repository}@${bundle.programme.sha ?? bundle.programme.branch}`,
    `Generated: ${bundle.generated_at}`,
    `Evidence cutoff: ${display(bundle.programme.evidence_cutoff)}`,
    `Objects: ${bundle.objects.length}`,
    `Relations: ${bundle.relations.length}`,
    `Selection groups: ${bundle.groups.length}`,
    "",
    "Evidence boundary:",
  ];
  const boundary = Object.entries(bundle.evidence_boundary);
  if (boundary.length === 0) lines.push("- UNKNOWN");
  else for (const [key, value] of boundary) lines.push(`- ${key}: ${display(value)}`);

  if (bundle.groups.length > 0) {
    lines.push("", "Selection groups:");
    bundle.groups.forEach((group, index) => {
      lines.push(`${index + 1}. ${group.label} [${group.kind}]`);
      lines.push(`   objects: ${group.entity_keys.join(" -> ") || "(none)"}`);
      if (group.relation_keys.length > 0) lines.push(`   relations: ${group.relation_keys.join(", ")}`);
    });
  }

  lines.push("", "Objects:");
  bundle.objects.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.display_id} — ${entry.title}`);
    lines.push(`  entity_key: ${entry.entity_key}`);
    lines.push(`  kind: ${entry.kind}`);
    lines.push(`  source: ${sourceRef(entry)}`);
    lines.push(`  evidence_cutoff: ${display(entry.evidence_cutoff)}`);
    lines.push(...metadataLines(entry, density));
    lines.push(...changeLines(entry));
  });

  if (bundle.relations.length > 0) {
    lines.push("", "Relationships:");
    for (const relation of bundle.relations) {
      lines.push(`- ${relation.source} -> ${relation.target}  ${relation.relation} [${relation.selected ? "selected" : "derived"}${relation.strength === "weak" ? ", weak" : ""}] field=${relation.field}`);
    }
  }

  lines.push(
    "",
    "Instruction:",
    "Resolve the cited canonical sources before making mutable-state claims. Do not infer unavailable Beads, Jira live state, runtime/deployment state, logical actor, credential principal, execution identity, mutation receipt, content binding, or signature from this bundle. UNKNOWN remains UNKNOWN.",
  );
  return lines.join("\n");
}

export function estimateContextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fallback below */ }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand("copy"); } finally { textarea.remove(); }
}

function EntryRow({ entry, density, onRemove }: { entry: ContextEntry; density: ContextDensity; onRemove: (key: string) => void }) {
  const relationCount = entry.selected_relations.length + entry.derived_relations.length;
  return (
    <li className={`pg-buffer-entry pg-buffer-entry-${density}`} data-entity-key={entry.entity_key}>
      <div className="pg-buffer-entry-hd">
        <span className="pg-buffer-kind-dot" aria-hidden="true" />
        <span className="pg-buffer-entry-id">{entry.display_id}</span>
        <span className="pg-buffer-entry-meta">{entry.kind}</span>
        <span className="pg-buffer-rel-count">{relationCount} rel · {entry.group_ids.length} groups</span>
        <button type="button" className="pg-buffer-remove" title="Remove from context" onClick={() => onRemove(entry.entity_key)}>×</button>
      </div>
      {density !== "compact" ? (
        <>
          <div className="pg-buffer-entry-title">{entry.title}</div>
          <div className="pg-buffer-entry-sub">
            <span>{entry.source_view}</span>
            {entry.path ? <span className="pg-buffer-path">{entry.path}</span> : null}
            <span className="pg-buffer-sha">{display(entry.source_sha)}</span>
          </div>
          {entry.change ? <div className="pg-buffer-selected-path">ChangeSet preserved · {entry.change.field_changes.length} fields / {entry.change.relation_changes.length} relations</div> : null}
          {density === "full" ? (
            <div className="pg-buffer-full">
              <div className="pg-buffer-meta-row">entity_key: {entry.entity_key}</div>
              <div className="pg-buffer-meta-row">authority: {display(entry.authority)}</div>
              <div className="pg-buffer-meta-row">evidence: {display(entry.evidence_class)}</div>
              <div className="pg-buffer-meta-row">evidence cutoff: {display(entry.evidence_cutoff)}</div>
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function SelectionPicker({ snapshot, onClose }: { snapshot: ProgrammeSnapshot; onClose: () => void }) {
  const addMany = useProgrammeContext((state) => state.addMany);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const candidates = useMemo(() => candidatesForCurrentView(snapshot), [snapshot]);
  const filtered = candidates.filter((candidate) => candidate.label.toLowerCase().includes(query.toLowerCase()) || candidate.key.toLowerCase().includes(query.toLowerCase()));

  const commit = () => {
    const drafts = candidates.filter((candidate) => selected.has(candidate.key)).map((candidate) => candidate.draft);
    if (drafts.length === 0) return;
    const views = [...new Set(drafts.map((draft) => draft.source_view))];
    addMany(drafts, { kind: "table_selection", label: `${views.join(" + ")} selection` });
    onClose();
  };

  return (
    <div className="pg-context-picker" role="dialog" aria-label="Select Programme objects for Context">
      <div className="pg-context-picker-head">
        <strong>Select objects</strong>
        <button type="button" className="pg-buffer-btn" onClick={onClose}>×</button>
      </div>
      <input className="pd-search" placeholder="Filter objects…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="pg-context-picker-list">
        {filtered.map((candidate) => (
          <label key={candidate.key} className="pg-context-picker-row">
            <input
              type="checkbox"
              checked={selected.has(candidate.key)}
              onChange={() => setSelected((current) => {
                const next = new Set(current);
                if (next.has(candidate.key)) next.delete(candidate.key); else next.add(candidate.key);
                return next;
              })}
            />
            <span>{candidate.label}</span>
            <span className="pd-mono pd-muted">{candidate.key}</span>
          </label>
        ))}
        {filtered.length === 0 ? <div className="pd-muted">No selectable objects in this view. Graph and Changes expose dedicated selection actions.</div> : null}
      </div>
      <div className="pg-context-picker-actions">
        <button type="button" className="pg-buffer-btn" onClick={() => setSelected(new Set(filtered.map((candidate) => candidate.key)))} disabled={filtered.length === 0}>Select visible</button>
        <button type="button" className="pd-button" onClick={commit} disabled={selected.size === 0}>Add selected · {selected.size}</button>
      </div>
    </div>
  );
}

export function ContextBuffer({ snapshot }: { snapshot: ProgrammeSnapshot }) {
  const entries = useProgrammeContext((state) => state.entries);
  const groups = useProgrammeContext((state) => state.groups);
  const density = useProgrammeContext((state) => state.density);
  const setDensity = useProgrammeContext((state) => state.setDensity);
  const remove = useProgrammeContext((state) => state.remove);
  const clear = useProgrammeContext((state) => state.clear);
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => { if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current); }, []);

  const bundle = useMemo(() => buildContextBundle(snapshot, entries, groups), [snapshot, entries, groups]);
  const contextText = useMemo(() => serializeContextBundle(bundle, density), [bundle, density]);
  const tokens = estimateContextTokens(contextText);
  const selectableCount = candidatesForCurrentView(snapshot).length;

  const copy = (text: string, label: string) => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    setCopied(label);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
    void writeClipboard(text);
  };

  if (!open) {
    return (
      <button type="button" className="pg-buffer-tab" title="Expand context buffer" onClick={() => setOpen(true)}>
        Context · {entries.length}
      </button>
    );
  }

  return (
    <>
      <aside className="pg-buffer" aria-label="Programme context buffer">
        <header className="pg-buffer-hd">
          <span className="pg-buffer-title">Context</span>
          <span className="pg-buffer-count">{entries.length} objects · {bundle.relations.length} relations · {bundle.groups.length} groups · ~{tokens.toLocaleString()} tokens</span>
          <button type="button" className="pg-buffer-btn" title="Select objects from current view" onClick={() => setPickerOpen(true)} disabled={selectableCount === 0}>+ Context</button>
          <div className="pg-buffer-dens" role="group" aria-label="Context density">
            {DENSITIES.map((item) => (
              <button key={item.id} type="button" className={density === item.id ? "pg-buffer-dens-btn is-active" : "pg-buffer-dens-btn"} onClick={() => setDensity(item.id)}>{item.label}</button>
            ))}
          </div>
          <button type="button" className="pg-buffer-btn" onClick={() => copy(serializeContextRefs(bundle), "refs")} disabled={entries.length === 0}>Copy refs</button>
          <button type="button" className="pg-buffer-btn" onClick={() => copy(contextText, "context")} disabled={entries.length === 0}>Copy context</button>
          <button type="button" className="pg-buffer-btn" onClick={() => copy(JSON.stringify(bundle, null, 2), "json")} disabled={entries.length === 0}>Copy JSON</button>
          <button type="button" className="pg-buffer-btn" onClick={clear} disabled={entries.length === 0}>Clear</button>
          <button type="button" className="pg-buffer-btn" title="Collapse context buffer" onClick={() => setOpen(false)}>×</button>
        </header>
        {copied ? <div className="pg-buffer-copied" role="status">Copied {copied}</div> : null}
        {groups.length > 0 ? (
          <div className="pg-buffer-groups">
            {groups.slice(-6).map((group) => <span key={group.id} className="pg-buffer-group-tag">{group.label} · {group.entity_keys.length}</span>)}
          </div>
        ) : null}
        <ul className="pg-buffer-list">
          {entries.length === 0 ? <li className="pg-buffer-empty">Nothing selected yet. Use + Context in a list, or Graph/Changes selection actions.</li> : null}
          {entries.map((entry) => <EntryRow key={entry.entity_key} entry={entry} density={density} onRemove={remove} />)}
        </ul>
      </aside>
      {pickerOpen ? <SelectionPicker snapshot={snapshot} onClose={() => setPickerOpen(false)} /> : null}
    </>
  );
}
