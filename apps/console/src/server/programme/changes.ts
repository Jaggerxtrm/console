// Deterministic per-entity change/revision analysis for the programme read
// model. Compares two observed snapshots (current vs previous meaningful
// revision) and produces collision-safe entity change sets, status trails from
// observed states only, and file-level revision history per entity.
//
// Rules:
//  - identity is always the graph node id (entity_key) — never kind+display_id;
//  - field changes are deterministic (sorted, added/removed/changed);
//  - relation changes list added/removed relations separately;
//  - status trails are built only from observed snapshots, never inferred;
//  - no synthetic workstream/assignment completion percentages anywhere.

import type {
  ProgrammeChangeSet,
  ProgrammeEntityChange,
  ProgrammeFieldChange,
  ProgrammeRelationChange,
  ProgrammeRevisionHistory,
  ProgrammeSnapshot,
  ProgrammeStatusTrailEntry,
} from "../../types/programme.ts";

const IGNORED_NODE_FIELDS = new Set(["metadata", "metadata_tree"]);
const IGNORED_TOP_LEVEL_FIELDS = new Set(["generated_at", "activity"]);

/** Kinds whose canonical id includes the colon prefix and must not be split. */
const PREFIXED_KINDS = new Set(["state", "journal", "publication", "collision"]);

/** Human display id (collision-safe identity is always entity_key).
 * Path-qualified duplicate records derive the canonical id from the path. */
export function displayIdOf(id: string, kind: string, path?: string | null): string {
  if (PREFIXED_KINDS.has(kind)) return id;
  if (path) {
    const m = /((?:OPS|EXP|WS|ADR|RESEARCH|PROP)-\d+)/i.exec(path);
    if (m) return m[1].toUpperCase();
  }
  const idx = id.indexOf(":");
  return idx > 0 ? id.slice(0, idx) : id;
}

export function scalarKey(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Deterministic added/removed/changed comparison of two flat records. */
export function diffFields(previous: Record<string, unknown>, current: Record<string, unknown>): ProgrammeFieldChange[] {
  const out: ProgrammeFieldChange[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const field of [...keys].sort()) {
    if (IGNORED_NODE_FIELDS.has(field)) continue;
    const prev = previous[field];
    const cur = current[field];
    if (!(field in previous)) {
      out.push({ field, kind: "added", current: cur });
    } else if (!(field in current)) {
      out.push({ field, kind: "removed", previous: prev });
    } else if (scalarKey(prev) !== scalarKey(cur)) {
      out.push({ field, kind: "changed", previous: prev, current: cur });
    }
  }
  return out;
}

function nodeFields(node: { status?: string | null; source_path?: string | null; metadata?: Record<string, unknown> }): Record<string, unknown> {
  return {
    status: node.status ?? null,
    source_path: node.source_path ?? null,
    ...(node.metadata ?? {}),
  };
}

function edgeKey(e: { source: string; target: string; relation: string; field: string }): string {
  return [e.source, e.target, e.relation, e.field].join("\u001f");
}

export function buildChangeSet(previous: ProgrammeSnapshot | null, current: ProgrammeSnapshot): ProgrammeChangeSet {
  const prevSha = previous?.programme?.sha ?? null;
  const curSha = current.programme.sha ?? null;
  const prevNodes = new Map(previous?.graph.nodes.map((n) => [n.id, n]) ?? []);
  const prevEdges = new Set(previous?.graph.edges.map(edgeKey) ?? []);
  const prevByPath = new Map(previous?.graph.nodes.map((n) => [n.source_path ?? "", n]) ?? []);

  const entities: ProgrammeEntityChange[] = [];
  const seen = new Set<string>();

  for (const node of current.graph.nodes) {
    const prevNode = prevNodes.get(node.id) ?? prevByPath.get(node.source_path ?? "");
    const path = node.source_path ?? null;
    const fieldChanges = prevNode ? diffFields(nodeFields(prevNode), nodeFields(node)) : diffFields({}, nodeFields(node));
    const relationChanges: ProgrammeRelationChange[] = [];
    for (const e of current.graph.edges) {
      if (e.source !== node.id && e.target !== node.id) continue;
      if (!prevEdges.has(edgeKey(e))) {
        relationChanges.push({ source: e.source, target: e.target, relation: e.relation, field: e.field, strength: e.strength, kind: "added" });
      }
    }
    if (prevNode) {
      for (const pe of previous?.graph.edges ?? []) {
        if (pe.source !== node.id && pe.target !== node.id) continue;
        if (!current.graph.edges.some((e) => edgeKey(e) === edgeKey(pe))) {
          relationChanges.push({ source: pe.source, target: pe.target, relation: pe.relation, field: pe.field, strength: pe.strength, kind: "removed" });
        }
      }
    }
    relationChanges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.relation.localeCompare(b.relation));
    const statusTrail: ProgrammeStatusTrailEntry[] = [];
    for (const snap of [previous, current]) {
      if (!snap) continue;
      const n = snap.graph.nodes.find((x) => x.id === node.id);
      statusTrail.push({ sha: snap.programme.sha ?? null, date: snap.generated_at, status: n?.status ?? null });
    }
    const previousRevisionSha = previous?.programme?.sha ?? null;
    const entity: ProgrammeEntityChange = {
      entity_key: node.id,
      display_id: displayIdOf(node.id, node.kind, path),
      kind: node.kind,
      title: node.title,
      path,
      field_changes: fieldChanges,
      relation_changes: relationChanges,
      status_trail: statusTrail,
      previous_revision_sha: previousRevisionSha,
      current_revision_sha: curSha ?? previousRevisionSha,
    };
    if (entity.field_changes.length === 0 && entity.relation_changes.length === 0 && !prevNode) {
      // New node with no observable fields/relations (e.g. a bare referenced
      // actor node). Still meaningful as "added".
      entities.push(entity);
    } else if (entity.field_changes.length > 0 || entity.relation_changes.length > 0 || !prevNode) {
      entities.push(entity);
    }
    seen.add(node.id);
  }

  // Removed nodes (present in previous, absent now).
  for (const prevNode of previous?.graph.nodes ?? []) {
    if (seen.has(prevNode.id)) continue;
    const node = current.graph.nodes.find((n) => n.id === prevNode.id);
    if (node) continue;
    const fieldChanges = diffFields(nodeFields(prevNode), {});
    const relationChanges: ProgrammeRelationChange[] = [];
    for (const pe of previous!.graph.edges) {
      if (pe.source !== prevNode.id && pe.target !== prevNode.id) continue;
      if (!current.graph.edges.some((e) => edgeKey(e) === edgeKey(pe))) {
        relationChanges.push({ source: pe.source, target: pe.target, relation: pe.relation, field: pe.field, strength: pe.strength, kind: "removed" });
      }
    }
    const statusTrail: ProgrammeStatusTrailEntry[] = [
      { sha: prevSha, date: previous!.generated_at, status: prevNode.status ?? null },
      { sha: curSha, date: current.generated_at, status: null },
    ];
    entities.push({
      entity_key: prevNode.id,
      display_id: displayIdOf(prevNode.id, prevNode.kind, prevNode.source_path),
      kind: prevNode.kind,
      title: prevNode.title,
      path: prevNode.source_path ?? null,
      field_changes: fieldChanges,
      relation_changes: relationChanges,
      status_trail: statusTrail,
      previous_revision_sha: prevSha,
      current_revision_sha: curSha ?? prevSha,
    });
  }

  entities.sort((a, b) => (a.kind === b.kind ? a.entity_key.localeCompare(b.entity_key) : a.kind.localeCompare(b.kind)));
  const relationCount = entities.reduce((sum, e) => sum + e.relation_changes.length, 0);
  return {
    previous_sha: prevSha,
    current_sha: curSha,
    generated_at: current.generated_at,
    entities,
    relation_count: relationCount,
  };
}

export function summaryFrom(changeSet: ProgrammeChangeSet): {
  previous_sha: string | null;
  current_sha: string | null;
  changed_entities: number;
  changed_entity_keys: string[];
  changed_relations: number;
} {
  return {
    previous_sha: changeSet.previous_sha,
    current_sha: changeSet.current_sha,
    changed_entities: changeSet.entities.length,
    changed_entity_keys: changeSet.entities.map((e) => e.entity_key),
    changed_relations: changeSet.relation_count,
  };
}

/** Build per-entity revision history from the live source. Hermetic sources
 * provide commit lists via `recentCommitsForPath`. */
export async function buildRevisionHistory(
  snapshot: ProgrammeSnapshot,
  paths: string[],
  fetchRevisions: (path: string) => Promise<Array<{ sha: string; date: string; subject: string; url: string }>>,
): Promise<ProgrammeRevisionHistory[]> {
  const out: ProgrammeRevisionHistory[] = [];
  const unique = [...new Set(paths)].sort();
  for (const path of unique) {
    const revisions = await fetchRevisions(path);
    const node = snapshot.graph.nodes.find((n) => n.source_path === path);
    out.push({
      entity_key: node?.id ?? path,
      path,
      revisions,
      current_revision_sha: revisions[0]?.sha ?? null,
      previous_revision_sha: revisions[1]?.sha ?? null,
    });
  }
  return out;
}
