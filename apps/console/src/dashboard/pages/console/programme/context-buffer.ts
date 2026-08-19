// Programme Context Buffer — session-only, cross-view selection memory.
//
// Every entry is addressed by collision-safe `entity_key` (the graph node id —
// never kind+display_id alone). Entries remember their source view, the
// selected path/relation context, selection group membership, whether the
// relation is selected vs derived, the evidence boundary and the source SHA
// of the snapshot they were captured from. Storage is sessionStorage only.

import { create } from "zustand";
import type { ProgrammeEdge, ProgrammeNode, ProgrammeSnapshot } from "../../../../types/programme.ts";
import { displayIdOf } from "./identity.ts";

export type ContextDensity = "compact" | "standard" | "full";

export type ContextSourceView =
  | "graph" | "workstreams" | "assignments" | "state" | "journals"
  | "adr" | "research" | "agents" | "jira" | "explore" | "diff";

export interface ContextRelationRef {
  /** Edge key (source/target/relation/field). */
  key: string;
  source: string;
  target: string;
  relation: string;
  field: string;
  strength: "strong" | "weak";
  /** True when the user selected this relation; false when it was included as
   * a derived neighbor of a selected entity. */
  selected: boolean;
}

export interface ContextEntry {
  /** Collision-safe graph node id. */
  entity_key: string;
  display_id: string;
  kind: string;
  title: string;
  path: string | null;
  /** Snapshot SHA the entry was captured from. */
  source_sha: string | null;
  source_view: ContextSourceView;
  selected_path?: string | null;
  /** Selection group membership (e.g. multi-select). */
  group?: string | null;
  selected_relations: ContextRelationRef[];
  derived_relations: ContextRelationRef[];
  /** Evidence boundary at capture time. */
  evidence_boundary: Record<string, string>;
  captured_at: string;
}

interface ContextBufferState {
  entries: ContextEntry[];
  density: ContextDensity;
  /** Cap on stored entries (session only). */
  maxEntries: number;
  add: (entry: Omit<ContextEntry, "captured_at">) => void;
  addNode: (
    snapshot: ProgrammeSnapshot,
    node: ProgrammeNode,
    options?: { source_view?: ContextSourceView; group?: string | null; selectedPath?: string | null; selectedRelations?: ProgrammeEdge[]; derivedRelations?: ProgrammeEdge[] },
  ) => void;
  remove: (entity_key: string) => void;
  clear: () => void;
  setDensity: (density: ContextDensity) => void;
  has: (entity_key: string) => boolean;
}

const LS_KEY = "programme:context-buffer:v1";

function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = typeof sessionStorage !== "undefined" && sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

const initial = readSession<ContextEntry[]>(LS_KEY, []);

export const useProgrammeContext = create<ContextBufferState>((set, get) => ({
  entries: initial,
  density: "standard",
  maxEntries: 200,

  add: (entry) => set((state) => {
    const full: ContextEntry = { ...entry, captured_at: new Date().toISOString() };
    const next = [full, ...state.entries.filter((e) => e.entity_key !== entry.entity_key)].slice(0, state.maxEntries);
    writeSession(LS_KEY, next);
    return { entries: next };
  }),

  addNode: (snapshot, node, options = {}) => {
    const entry: Omit<ContextEntry, "captured_at"> = {
      entity_key: node.id,
      display_id: displayIdOf({ id: node.id, kind: node.kind }),
      kind: node.kind,
      title: node.title,
      path: node.source_path ?? null,
      source_sha: snapshot.programme.sha ?? null,
      source_view: options.source_view ?? "graph",
      selected_path: options.selectedPath ?? null,
      group: options.group ?? null,
      selected_relations: (options.selectedRelations ?? []).map((e) => ({
        key: [e.source, e.target, e.relation, e.field].join("\u001f"),
        source: e.source,
        target: e.target,
        relation: e.relation,
        field: e.field,
        strength: e.strength,
        selected: true,
      })),
      derived_relations: (options.derivedRelations ?? []).map((e) => ({
        key: [e.source, e.target, e.relation, e.field].join("\u001f"),
        source: e.source,
        target: e.target,
        relation: e.relation,
        field: e.field,
        strength: e.strength,
        selected: false,
      })),
      evidence_boundary: snapshot.evidence_boundary ?? {},
    };
    get().add(entry);
  },

  remove: (entity_key) => set((state) => {
    const next = state.entries.filter((e) => e.entity_key !== entity_key);
    writeSession(LS_KEY, next);
    return { entries: next };
  }),

  clear: () => {
    writeSession(LS_KEY, []);
    set({ entries: [] });
  },

  setDensity: (density) => set({ density }),
  has: (entity_key) => get().entries.some((e) => e.entity_key === entity_key),
}));
