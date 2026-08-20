// Collision-safe programme entity identity.
//
// The read model preserves canonical collisions (e.g. two different
// assignments both labelled EXP-005) as a `collision` hub node plus
// path-qualified duplicate records. A bare `display_id` is therefore never a
// unique identity. Every surface must address entities by `entity_key`, which
// is the graph node id (collision hub: the raw id; path-qualified record:
// `kind:path`) — never kind+display_id alone.
//
// These helpers centralize the mapping so Explore, the drawer, the graph,
// the context buffer and the diff/change surfaces agree on identity.

import type { ProgrammeSnapshot } from "../../../../types/programme.ts";

/** Kinds whose canonical id already includes the colon prefix and must not be
 * split when deriving the human display id. */
const PREFIXED_KINDS = new Set(["state", "journal", "publication", "collision"]);

/** Human display id of a graph node. For path-qualified duplicate records
 * (`assignment:assignments/EXP-005-website-ia.yaml`) this derives the canonical
 * id from the path basename (`EXP-005`); for state/journal/publication nodes
 * the prefixed id is the id itself (`state:coordinator`). */
export function displayIdOf(node: { id: string; kind: string; source_path?: string | null }): string {
  if (PREFIXED_KINDS.has(node.kind)) return node.id;
  const idx = node.id.indexOf(":");
  if (idx > 0 && node.source_path) {
    const m = /((?:OPS|EXP|WS|ADR|RESEARCH|PROP)-\d+)/i.exec(node.source_path);
    if (m) return m[1].toUpperCase();
  }
  return idx > 0 ? node.id.slice(0, idx) : node.id;
}

/** Unique identity of a graph node (the graph node id — already collision-safe). */
export function entityKeyOf(node: { id: string; kind: string; source_path?: string | null }): string {
  return node.id;
}

/** Human-readable path-qualified label for display, e.g. `EXP-005
 * (assignments/EXP-005-website-ia.yaml)`. */
export function displayLabel(node: { id: string; kind: string; source_path?: string | null }): string {
  const id = node.id;
  const path = node.source_path;
  if (!path) return id;
  const base = displayIdOf(node);
  if (path.includes(base)) return id;
  return `${id} (${path})`;
}

/** Stable, collision-safe key built from the record id plus its canonical
 * source path — for records that are not (or not uniquely) graph nodes. */
export function recordKey(id: string, path: string): string {
  return `${id}::${path}`;
}

export interface KeyedRecord {
  /** Graph node id (already collision-safe). */
  key: string;
  displayId: string;
  kind: string;
  path: string | null;
}

/** Resolve a snapshot record to its graph node identity, falling back to a
 * path-qualified key for records that exist outside the graph. */
export function resolveRecord(snapshot: ProgrammeSnapshot, rec: { id: string; kind: string; path?: string | null }): KeyedRecord | null {
  const graphNode = snapshot.graph.nodes.find((n) => n.id === rec.id && n.kind === rec.kind);
  if (graphNode) {
    return { key: graphNode.id, displayId: displayIdOf(graphNode), kind: graphNode.kind, path: graphNode.source_path ?? null };
  }
  const exact = snapshot.graph.nodes.find((n) => n.id === rec.id);
  if (exact) {
    return { key: exact.id, displayId: displayIdOf(exact), kind: exact.kind, path: exact.source_path ?? null };
  }
  // Record not in graph (e.g. a journal/state with no node): path-qualified.
  const path = rec.path ?? "";
  return {
    key: rec.path ? recordKey(rec.id, rec.path) : rec.id,
    displayId: displayIdOf({ id: rec.id, kind: rec.kind, source_path: path }),
    kind: rec.kind,
    path: rec.path ?? null,
  };
}
