// Programme Context Buffer — session-only, cross-view selection memory.
//
// Entity identity is always collision-safe `entity_key` (graph node id). The
// store deduplicates entities without discarding selection-group membership,
// selected paths, relation provenance, source SHAs, or entity ChangeSets.

import { create } from "zustand";
import type {
  ProgrammeEdge,
  ProgrammeEntityChange,
  ProgrammeNode,
  ProgrammeSnapshot,
} from "../../../../types/programme.ts";
import { displayIdOf } from "./identity.ts";

export type ContextDensity = "compact" | "standard" | "full";
export type ContextSourceView =
  | "graph" | "workstreams" | "assignments" | "state" | "journals"
  | "adr" | "research" | "agents" | "jira" | "explore" | "diff";
export type ContextSelectionKind =
  | "manual" | "table_selection" | "visible_selection" | "graph_path"
  | "graph_neighborhood" | "diff_selection";

export interface ContextRelationRef {
  key: string;
  source: string;
  target: string;
  relation: string;
  field: string;
  strength: "strong" | "weak";
  /** selected=true means the user explicitly selected this relation/path. */
  selected: boolean;
}

export interface ContextSelectionGroup {
  id: string;
  kind: ContextSelectionKind;
  label: string;
  entity_keys: string[];
  relation_keys: string[];
  created_at: string;
}

export interface ContextEntry {
  entity_key: string;
  display_id: string;
  kind: string;
  title: string;
  status: string | null;
  authority: string | null;
  evidence_class: string | null;
  freshness: string | null;
  path: string | null;
  source_repository: string;
  source_branch: string;
  /** Most recently captured source SHA. */
  source_sha: string | null;
  /** All source SHAs under which this entity was captured in this buffer. */
  source_shas: string[];
  evidence_cutoff: string | null;
  source_view: ContextSourceView;
  selected_path?: string | null;
  group_ids: string[];
  selected_relations: ContextRelationRef[];
  derived_relations: ContextRelationRef[];
  evidence_boundary: Record<string, string>;
  metadata: Record<string, unknown>;
  /** Optional exact entity-level change evidence captured from Changes. */
  change?: ProgrammeEntityChange | null;
  captured_at: string;
}

type ContextDraft = Omit<ContextEntry, "captured_at" | "source_shas"> & { source_shas?: string[] };

interface ContextBufferState {
  entries: ContextEntry[];
  groups: ContextSelectionGroup[];
  density: ContextDensity;
  maxEntries: number;
  add: (entry: ContextDraft) => void;
  addMany: (entries: ContextDraft[], group?: Omit<ContextSelectionGroup, "id" | "created_at" | "entity_keys" | "relation_keys">) => void;
  addNode: (
    snapshot: ProgrammeSnapshot,
    node: ProgrammeNode,
    options?: {
      source_view?: ContextSourceView;
      group?: string | null;
      selectedPath?: string | null;
      selectedRelations?: ProgrammeEdge[];
      derivedRelations?: ProgrammeEdge[];
    },
  ) => void;
  addSelection: (
    snapshot: ProgrammeSnapshot,
    nodes: ProgrammeNode[],
    options: {
      kind: ContextSelectionKind;
      label: string;
      source_view?: ContextSourceView;
      selectedPath?: string | null;
      selectedRelations?: ProgrammeEdge[];
      derivedRelations?: ProgrammeEdge[];
    },
  ) => void;
  addChange: (snapshot: ProgrammeSnapshot, change: ProgrammeEntityChange) => void;
  remove: (entityKey: string) => void;
  clear: () => void;
  setDensity: (density: ContextDensity) => void;
  has: (entityKey: string) => boolean;
}

const STORAGE_KEY = "programme:context-buffer:v2";
let groupSequence = 0;

function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = typeof sessionStorage !== "undefined" && sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeSession(entries: ContextEntry[], groups: ContextSelectionGroup[]): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, groups }));
  } catch {
    // private mode / quota: in-memory buffer remains useful
  }
}

function initialState(): { entries: ContextEntry[]; groups: ContextSelectionGroup[] } {
  const value = readSession<{ entries?: ContextEntry[]; groups?: ContextSelectionGroup[] }>(STORAGE_KEY, {});
  return {
    entries: Array.isArray(value.entries) ? value.entries : [],
    groups: Array.isArray(value.groups) ? value.groups : [],
  };
}

function relationRef(edge: ProgrammeEdge, selected: boolean): ContextRelationRef {
  return {
    key: [edge.source, edge.target, edge.relation, edge.field].join("\u001f"),
    source: edge.source,
    target: edge.target,
    relation: edge.relation,
    field: edge.field,
    strength: edge.strength,
    selected,
  };
}

function unionRelations(
  existingSelected: ContextRelationRef[],
  existingDerived: ContextRelationRef[],
  incomingSelected: ContextRelationRef[],
  incomingDerived: ContextRelationRef[],
): { selected: ContextRelationRef[]; derived: ContextRelationRef[] } {
  const selected = new Map(existingSelected.map((rel) => [rel.key, { ...rel, selected: true }]));
  for (const rel of incomingSelected) selected.set(rel.key, { ...rel, selected: true });
  const derived = new Map(existingDerived.map((rel) => [rel.key, { ...rel, selected: false }]));
  for (const rel of incomingDerived) if (!selected.has(rel.key)) derived.set(rel.key, { ...rel, selected: false });
  for (const key of selected.keys()) derived.delete(key);
  return {
    selected: [...selected.values()].sort((a, b) => a.key.localeCompare(b.key)),
    derived: [...derived.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function metadataValue(metadata: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!metadata) return null;
  const queue: Record<string, unknown>[] = [metadata];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const key of keys) {
      const value = current[key];
      if (value !== undefined && value !== null && value !== "") {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object" && !Array.isArray(value)) queue.push(value as Record<string, unknown>);
    }
  }
  return null;
}

export function contextDraftForNode(
  snapshot: ProgrammeSnapshot,
  node: ProgrammeNode,
  options: {
    source_view?: ContextSourceView;
    groupIds?: string[];
    selectedPath?: string | null;
    selectedRelations?: ProgrammeEdge[];
    derivedRelations?: ProgrammeEdge[];
    change?: ProgrammeEntityChange | null;
  } = {},
): ContextDraft {
  const metadata = node.metadata ?? {};
  return {
    entity_key: node.id,
    display_id: displayIdOf({ id: node.id, kind: node.kind, source_path: node.source_path }),
    kind: node.kind,
    title: node.title,
    status: node.status ?? null,
    authority: metadataValue(metadata, ["authority", "authority.source"]),
    evidence_class: metadataValue(metadata, ["evidence_class", "authority_class"]),
    freshness: snapshot.source_health?.status ?? null,
    path: node.source_path ?? null,
    source_repository: snapshot.programme.repository,
    source_branch: snapshot.programme.branch,
    source_sha: snapshot.programme.sha ?? null,
    evidence_cutoff: snapshot.now?.evidence_cutoff ?? null,
    source_view: options.source_view ?? "graph",
    selected_path: options.selectedPath ?? null,
    group_ids: options.groupIds ?? [],
    selected_relations: (options.selectedRelations ?? []).map((edge) => relationRef(edge, true)),
    derived_relations: (options.derivedRelations ?? []).map((edge) => relationRef(edge, false)),
    evidence_boundary: snapshot.evidence_boundary ?? {},
    metadata,
    change: options.change ?? null,
  };
}

function mergeEntry(existing: ContextEntry | undefined, draft: ContextDraft, capturedAt: string): ContextEntry {
  if (!existing) {
    return {
      ...draft,
      source_shas: [...new Set([...(draft.source_shas ?? []), ...(draft.source_sha ? [draft.source_sha] : [])])],
      captured_at: capturedAt,
    };
  }
  const relations = unionRelations(
    existing.selected_relations,
    existing.derived_relations,
    draft.selected_relations,
    draft.derived_relations,
  );
  return {
    ...existing,
    ...draft,
    group_ids: [...new Set([...existing.group_ids, ...draft.group_ids])],
    selected_relations: relations.selected,
    derived_relations: relations.derived,
    source_shas: [...new Set([...existing.source_shas, ...(draft.source_shas ?? []), ...(draft.source_sha ? [draft.source_sha] : [])])],
    selected_path: draft.selected_path ?? existing.selected_path ?? null,
    change: draft.change ?? existing.change ?? null,
    captured_at: capturedAt,
  };
}

function makeGroupId(): string {
  groupSequence += 1;
  return `ctx-${Date.now().toString(36)}-${groupSequence.toString(36)}`;
}

const initial = initialState();

export const useProgrammeContext = create<ContextBufferState>((set, get) => ({
  entries: initial.entries,
  groups: initial.groups,
  density: "standard",
  maxEntries: 200,

  add: (draft) => set((state) => {
    const now = new Date().toISOString();
    const existing = state.entries.find((entry) => entry.entity_key === draft.entity_key);
    const merged = mergeEntry(existing, draft, now);
    const next = [merged, ...state.entries.filter((entry) => entry.entity_key !== draft.entity_key)].slice(0, state.maxEntries);
    writeSession(next, state.groups);
    return { entries: next };
  }),

  addMany: (drafts, groupSpec) => set((state) => {
    const now = new Date().toISOString();
    const groupId = groupSpec ? makeGroupId() : null;
    const relationKeys = new Set<string>();
    const entityKeys: string[] = [];
    const byKey = new Map(state.entries.map((entry) => [entry.entity_key, entry]));

    for (const draft0 of drafts) {
      const draft: ContextDraft = groupId ? { ...draft0, group_ids: [...new Set([...draft0.group_ids, groupId])] } : draft0;
      entityKeys.push(draft.entity_key);
      for (const rel of [...draft.selected_relations, ...draft.derived_relations]) relationKeys.add(rel.key);
      byKey.set(draft.entity_key, mergeEntry(byKey.get(draft.entity_key), draft, now));
    }

    const incomingKeys = new Set(drafts.map((draft) => draft.entity_key));
    const ordered = [
      ...drafts.map((draft) => byKey.get(draft.entity_key)!).filter(Boolean),
      ...state.entries.filter((entry) => !incomingKeys.has(entry.entity_key)).map((entry) => byKey.get(entry.entity_key)!).filter(Boolean),
    ].slice(0, state.maxEntries);

    const groups = groupSpec && groupId
      ? [...state.groups, {
          id: groupId,
          kind: groupSpec.kind,
          label: groupSpec.label,
          entity_keys: [...new Set(entityKeys)],
          relation_keys: [...relationKeys].sort(),
          created_at: now,
        }]
      : state.groups;

    writeSession(ordered, groups);
    return { entries: ordered, groups };
  }),

  addNode: (snapshot, node, options = {}) => {
    const groupIds = options.group ? [options.group] : [];
    get().add(contextDraftForNode(snapshot, node, {
      source_view: options.source_view,
      groupIds,
      selectedPath: options.selectedPath,
      selectedRelations: options.selectedRelations,
      derivedRelations: options.derivedRelations,
    }));
  },

  addSelection: (snapshot, nodes, options) => {
    const selectedRelations = options.selectedRelations ?? [];
    const derivedRelations = options.derivedRelations ?? [];
    const drafts = nodes.map((node) => contextDraftForNode(snapshot, node, {
      source_view: options.source_view ?? "graph",
      selectedPath: options.selectedPath,
      selectedRelations: selectedRelations.filter((edge) => edge.source === node.id || edge.target === node.id),
      derivedRelations: derivedRelations.filter((edge) => edge.source === node.id || edge.target === node.id),
    }));
    get().addMany(drafts, { kind: options.kind, label: options.label });
  },

  addChange: (snapshot, change) => {
    const node = snapshot.graph.nodes.find((candidate) => candidate.id === change.entity_key);
    const draft: ContextDraft = node
      ? contextDraftForNode(snapshot, node, { source_view: "diff", change })
      : {
          entity_key: change.entity_key,
          display_id: change.display_id,
          kind: change.kind,
          title: change.title,
          status: change.status_trail.at(-1)?.status ?? null,
          authority: null,
          evidence_class: null,
          freshness: snapshot.source_health?.status ?? null,
          path: change.path,
          source_repository: snapshot.programme.repository,
          source_branch: snapshot.programme.branch,
          source_sha: snapshot.programme.sha ?? null,
          evidence_cutoff: snapshot.now?.evidence_cutoff ?? null,
          source_view: "diff",
          selected_path: null,
          group_ids: [],
          selected_relations: [],
          derived_relations: [],
          evidence_boundary: snapshot.evidence_boundary ?? {},
          metadata: {},
          change,
        };
    get().addMany([draft], { kind: "diff_selection", label: `Change: ${change.display_id}` });
  },

  remove: (entityKey) => set((state) => {
    const entries = state.entries.filter((entry) => entry.entity_key !== entityKey);
    const groups = state.groups
      .map((group) => ({ ...group, entity_keys: group.entity_keys.filter((key) => key !== entityKey) }))
      .filter((group) => group.entity_keys.length > 0 || group.relation_keys.length > 0);
    writeSession(entries, groups);
    return { entries, groups };
  }),

  clear: () => {
    writeSession([], []);
    set({ entries: [], groups: [] });
  },

  setDensity: (density) => set({ density }),
  has: (entityKey) => get().entries.some((entry) => entry.entity_key === entityKey),
}));
