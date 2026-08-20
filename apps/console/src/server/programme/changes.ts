// Deterministic per-entity change/revision analysis for the programme read
// model. Compares two exact observed snapshots and produces collision-safe
// entity change sets, status trails from observed evidence only, and explicitly
// FILE-level revision history per entity source path.

import type {
  ProgrammeChangeSet,
  ProgrammeEntityChange,
  ProgrammeFieldChange,
  ProgrammeRelationChange,
  ProgrammeRevisionHistory,
  ProgrammeSnapshot,
  ProgrammeStatusTrailEntry,
} from "../../types/programme.ts";

const IGNORED_NODE_FIELDS = new Set(["metadata_tree"]);
const PREFIXED_KINDS = new Set(["state", "journal", "publication", "collision"]);

/** Human display id (collision-safe identity is always entity_key). */
export function displayIdOf(id: string, kind: string, path?: string | null): string {
  if (PREFIXED_KINDS.has(kind)) return id;
  if (path) {
    const m = /((?:OPS|EXP|WS|ADR|RESEARCH|PROP)-\d+)/i.exec(path);
    if (m) return m[1].toUpperCase();
  }
  const idx = id.indexOf(":");
  return idx > 0 ? id.slice(0, idx) : id;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function scalarKey(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "object") return JSON.stringify(canonical(value));
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
    if (!(field in previous)) out.push({ field, kind: "added", current: cur });
    else if (!(field in current)) out.push({ field, kind: "removed", previous: prev });
    else if (scalarKey(prev) !== scalarKey(cur)) out.push({ field, kind: "changed", previous: prev, current: cur });
  }
  return out;
}

function nodeFields(node: {
  kind: string;
  title: string;
  status?: string | null;
  source_path?: string | null;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    kind: node.kind,
    title: node.title,
    status: node.status ?? null,
    source_path: node.source_path ?? null,
    ...(node.metadata ?? {}),
  };
}

function edgeKey(e: { source: string; target: string; relation: string; field: string; strength?: string }): string {
  return [e.source, e.target, e.relation, e.field, e.strength ?? "strong"].join("\u001f");
}

function relationChangeKey(change: ProgrammeRelationChange): string {
  return [change.kind, change.source, change.target, change.relation, change.field, change.strength].join("\u001f");
}

/** Only path-fallback when a path names exactly one node in the snapshot.
 * Shared files such as agents/registry.yaml must never alias one actor to
 * another simply because they have the same source path. */
function uniqueNodesByPath(snapshot: ProgrammeSnapshot | null): Map<string, ProgrammeSnapshot["graph"]["nodes"][number]> {
  const buckets = new Map<string, ProgrammeSnapshot["graph"]["nodes"]>();
  for (const node of snapshot?.graph.nodes ?? []) {
    const path = node.source_path ?? "";
    if (!path) continue;
    const bucket = buckets.get(path) ?? [];
    bucket.push(node);
    buckets.set(path, bucket);
  }
  const out = new Map<string, ProgrammeSnapshot["graph"]["nodes"][number]>();
  for (const [path, nodes] of buckets) if (nodes.length === 1) out.set(path, nodes[0]);
  return out;
}

function snapshotEvidenceDate(snapshot: ProgrammeSnapshot): string {
  const sha = snapshot.programme.sha;
  const exact = sha ? snapshot.activity.find((item) => item.sha === sha) : null;
  return exact?.date || snapshot.activity[0]?.date || snapshot.generated_at;
}

function observedStatus(snapshot: ProgrammeSnapshot, entityKey: string): ProgrammeStatusTrailEntry {
  const node = snapshot.graph.nodes.find((candidate) => candidate.id === entityKey);
  return {
    sha: snapshot.programme.sha ?? null,
    date: snapshotEvidenceDate(snapshot),
    status: node?.status ?? null,
  };
}

export function buildChangeSet(previous: ProgrammeSnapshot | null, current: ProgrammeSnapshot): ProgrammeChangeSet {
  const prevSha = previous?.programme.sha ?? null;
  const curSha = current.programme.sha ?? null;
  const prevNodes = new Map(previous?.graph.nodes.map((n) => [n.id, n]) ?? []);
  const prevUniqueByPath = uniqueNodesByPath(previous);
  const prevEdges = new Set(previous?.graph.edges.map(edgeKey) ?? []);
  const currentEdges = new Set(current.graph.edges.map(edgeKey));

  const entities: ProgrammeEntityChange[] = [];
  const seen = new Set<string>();

  for (const node of current.graph.nodes) {
    const path = node.source_path ?? null;
    const prevNode = prevNodes.get(node.id) ?? (path ? prevUniqueByPath.get(path) : undefined);
    const fieldChanges = prevNode ? diffFields(nodeFields(prevNode), nodeFields(node)) : diffFields({}, nodeFields(node));
    const relationChanges: ProgrammeRelationChange[] = [];

    for (const edge of current.graph.edges) {
      if (edge.source !== node.id && edge.target !== node.id) continue;
      if (!prevEdges.has(edgeKey(edge))) {
        relationChanges.push({ ...edge, kind: "added" });
      }
    }
    if (prevNode && previous) {
      for (const edge of previous.graph.edges) {
        if (edge.source !== prevNode.id && edge.target !== prevNode.id) continue;
        if (!currentEdges.has(edgeKey(edge))) relationChanges.push({ ...edge, kind: "removed" });
      }
    }
    relationChanges.sort((a, b) =>
      a.source.localeCompare(b.source)
      || a.target.localeCompare(b.target)
      || a.relation.localeCompare(b.relation)
      || a.field.localeCompare(b.field)
      || a.kind.localeCompare(b.kind),
    );

    const statusTrail: ProgrammeStatusTrailEntry[] = [];
    if (previous) statusTrail.push(observedStatus(previous, prevNode?.id ?? node.id));
    statusTrail.push(observedStatus(current, node.id));

    const entity: ProgrammeEntityChange = {
      entity_key: node.id,
      display_id: displayIdOf(node.id, node.kind, path),
      kind: node.kind,
      title: node.title,
      path,
      field_changes: fieldChanges,
      relation_changes: relationChanges,
      status_trail: statusTrail,
      previous_revision_sha: prevSha,
      current_revision_sha: curSha,
    };

    if (fieldChanges.length > 0 || relationChanges.length > 0 || !prevNode) entities.push(entity);
    seen.add(node.id);
  }

  // Removed nodes (present in previous, absent now).
  for (const prevNode of previous?.graph.nodes ?? []) {
    if (seen.has(prevNode.id)) continue;
    const fieldChanges = diffFields(nodeFields(prevNode), {});
    const relationChanges: ProgrammeRelationChange[] = [];
    for (const edge of previous!.graph.edges) {
      if (edge.source !== prevNode.id && edge.target !== prevNode.id) continue;
      if (!currentEdges.has(edgeKey(edge))) relationChanges.push({ ...edge, kind: "removed" });
    }
    relationChanges.sort((a, b) =>
      a.source.localeCompare(b.source)
      || a.target.localeCompare(b.target)
      || a.relation.localeCompare(b.relation)
      || a.field.localeCompare(b.field),
    );
    entities.push({
      entity_key: prevNode.id,
      display_id: displayIdOf(prevNode.id, prevNode.kind, prevNode.source_path),
      kind: prevNode.kind,
      title: prevNode.title,
      path: prevNode.source_path ?? null,
      field_changes: fieldChanges,
      relation_changes: relationChanges,
      status_trail: [observedStatus(previous!, prevNode.id), observedStatus(current, prevNode.id)],
      previous_revision_sha: prevSha,
      current_revision_sha: curSha,
    });
  }

  entities.sort((a, b) => (a.kind === b.kind ? a.entity_key.localeCompare(b.entity_key) : a.kind.localeCompare(b.kind)));
  const uniqueRelationChanges = new Set<string>();
  for (const entity of entities) for (const change of entity.relation_changes) uniqueRelationChanges.add(relationChangeKey(change));

  return {
    previous_sha: prevSha,
    current_sha: curSha,
    generated_at: current.generated_at,
    entities,
    relation_count: uniqueRelationChanges.size,
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

/** Build FILE-level revision history for canonical source paths. This endpoint
 * deliberately does not call file commits "entity changes": a shared source
 * file may contain unrelated record edits. */
export async function buildRevisionHistory(
  snapshot: ProgrammeSnapshot,
  paths: string[],
  fetchRevisions: (path: string) => Promise<Array<{ sha: string; date: string; subject: string; url: string }>>,
  entityKeys: Record<string, string> = {},
): Promise<ProgrammeRevisionHistory[]> {
  const out: ProgrammeRevisionHistory[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const revisions = await fetchRevisions(path);
    const node = snapshot.graph.nodes.find((n) => n.source_path === path);
    out.push({
      entity_key: entityKeys[path] ?? node?.id ?? path,
      path,
      revisions,
      current_revision_sha: revisions[0]?.sha ?? null,
      previous_revision_sha: revisions[1]?.sha ?? null,
    });
  }
  return out;
}
