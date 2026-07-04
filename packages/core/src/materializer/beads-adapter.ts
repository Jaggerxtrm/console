import type { Database } from "bun:sqlite";
import { snapshotDiff, snapshotHash } from "./snapshot-diff.ts";
import type { MaterializerLogEntry } from "./materializer.ts";
import type { MaterializedDependency, MaterializedIssue, MaterializerAdapter, MaterializerCursor, MaterializerDelta, MaterializerSnapshot } from "./types.ts";

/**
 * Bead source shape read by the materializer. Structurally compatible with the
 * host's full BeadIssue; only the fields the adapter reads are required.
 */
export interface MaterializerBeadDependency {
  id: string;
  dependency_type: string;
}

export interface MaterializerBeadIssue {
  id: string;
  title: unknown;
  description: string | null;
  notes?: unknown;
  status: string;
  priority?: number;
  issue_type?: unknown;
  owner: string | null;
  dependencies: MaterializerBeadDependency[];
  parent_id?: string;
  related_ids: string[];
  labels: string[];
  metadata?: unknown;
  formula_name?: unknown;
  template_name?: unknown;
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  close_reason?: string;
}

/**
 * Ports the host wires. The adapter owns write/normalize/diff logic; the host
 * owns snapshot reads (Dolt/jsonl) and logging.
 */
export interface BeadsAdapterPorts {
  sourceKey: string;
  projectId: string;
  xtrmDb: Database;
  readSnapshot: () => Promise<readonly MaterializerBeadIssue[]>;
  emitLog?: (entry: MaterializerLogEntry) => void;
}

type BeadsCursor = { snapshot_hash: string | null };

export class BeadsAdapter implements MaterializerAdapter<MaterializedIssue, MaterializedDependency> {
  static loggedNormalize = false;

  constructor(private readonly ports: BeadsAdapterPorts) {}

  async cursor(): Promise<MaterializerCursor> {
    return { snapshot_hash: await this.getStoredSnapshotHash() } satisfies BeadsCursor;
  }

  async changesSince(): Promise<MaterializerDelta<MaterializedIssue, MaterializedDependency>> {
    const next = await this.readSnapshotIssues();
    const prev = await this.readCurrentIssues();
    const diff = snapshotDiff(prev.rows, next.rows, issueKey);
    const nextHash = snapshotHash(
      [...next.rows.map((row) => ({ kind: "issue" as const, row })), ...next.dependencies.map((row) => ({ kind: "dependency" as const, row }))],
      (entry) => entry.kind === "issue" ? issueKey(entry.row) : dependencyKey(entry.row),
    );
    return {
      cursor: { snapshot_hash: nextHash },
      rows: [...diff.upserts, ...diff.tombstones.map(markTombstone)],
      dependencies: next.dependencies,
    };
  }

  async snapshot(): Promise<MaterializerSnapshot<MaterializedIssue, MaterializedDependency>> {
    return this.readSnapshotIssues();
  }

  write(db: Database, snapshot: MaterializerSnapshot<MaterializedIssue, MaterializedDependency>): void {
    this.deleteDependencies(db, snapshot.rows);
    this.writeIssues(db, snapshot.rows);
    this.writeDependencies(db, snapshot.dependencies ?? []);
    // NOTE: tombstoneMissing is intentionally NOT called here. changesSince()
    // already emits tombstone rows via diff.tombstones (with state='deleted')
    // for issues that disappeared. Running tombstoneMissing on a delta-shaped
    // snapshot would tombstone every active issue not in the small set of
    // changed rows — exactly the cross-project wipe bug fixed in forge-eorh.70.
    // For full resync (no diff context), use writeFull() instead.
  }

  /**
   * Resync write path: writes a FULL snapshot AND tombstones any active
   * substrate row for this project that is missing from the snapshot.
   * Called only by Materializer.resync(), never by runOnce.
   */
  writeFull(db: Database, snapshot: MaterializerSnapshot<MaterializedIssue, MaterializedDependency>): void {
    this.deleteDependencies(db, snapshot.rows);
    this.writeIssues(db, snapshot.rows);
    this.writeDependencies(db, snapshot.dependencies ?? []);
    this.tombstoneMissing(db, snapshot.rows);
  }

  private writeIssues(db: Database, rows: readonly MaterializedIssue[]): { rowsWithRealPriority: number; rowsWithRealType: number; rowsWithLabels: number } {
    const stmt = db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, runtime_kind, formula_name, template_name, contract_kind, contract_xml, metadata_json, deleted_at, closed_at, close_reason, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET title=excluded.title, body=excluded.body, state=excluded.state, priority=excluded.priority, issue_type=excluded.issue_type, owner=excluded.owner, labels=excluded.labels, related_ids=excluded.related_ids, parent_id=excluded.parent_id, runtime_kind=excluded.runtime_kind, formula_name=excluded.formula_name, template_name=excluded.template_name, contract_kind=excluded.contract_kind, contract_xml=excluded.contract_xml, metadata_json=excluded.metadata_json, deleted_at=excluded.deleted_at, closed_at=excluded.closed_at, close_reason=excluded.close_reason, notes=excluded.notes, created_at=excluded.created_at, updated_at=excluded.updated_at");
    const counts = { rowsWithRealPriority: 0, rowsWithRealType: 0, rowsWithLabels: 0 };
    for (const row of rows) {
      if ((row.priority ?? 2) !== 2) counts.rowsWithRealPriority += 1;
      if ((row.issue_type ?? "task") !== "task") counts.rowsWithRealType += 1;
      if (parseJsonArray(row.labels).length > 0) counts.rowsWithLabels += 1;
      stmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.title, row.body, row.state, row.priority, row.issue_type, row.owner, row.labels, row.related_ids, row.parent_id, row.runtime_kind, row.formula_name, row.template_name, row.contract_kind, row.contract_xml, row.metadata_json, row.deleted_at, row.closed_at, row.close_reason, row.notes, row.created_at, row.updated_at]));
    }
    return counts;
  }

  private writeDependencies(db: Database, rows: readonly MaterializedDependency[]): void {
    const stmt = db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id, dep_issue_id) DO UPDATE SET relation=excluded.relation, created_at=excluded.created_at");
    for (const row of rows) stmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.dep_issue_id, row.relation, row.created_at]));
    const edgeStmt = db.query("INSERT INTO substrate_issue_edges (repo_slug, from_issue_id, to_issue_id, relation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_slug, from_issue_id, to_issue_id, relation) DO UPDATE SET created_at=excluded.created_at");
    for (const row of rows) edgeStmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.dep_issue_id, row.relation, row.created_at]));
  }

  private deleteDependencies(db: Database, issues: readonly MaterializedIssue[]): void {
    const stmt = db.query("DELETE FROM substrate_dependencies WHERE repo_slug = ? AND issue_id = ?");
    const edgeStmt = db.query("DELETE FROM substrate_issue_edges WHERE repo_slug = ? AND from_issue_id = ?");
    for (const row of issues) {
      stmt.run(row.repo_slug, row.issue_id);
      edgeStmt.run(row.repo_slug, row.issue_id);
    }
  }

  private tombstoneMissing(db: Database, rows: readonly MaterializedIssue[]): void {
    const projectId = this.ports.projectId;
    const keys = new Set(rows.filter((row) => row.repo_slug === projectId).map((row) => row.issue_id));
    const active = db.query("SELECT issue_id FROM substrate_issues WHERE deleted_at IS NULL AND repo_slug = ?").all(projectId) as Array<{ issue_id: string }>;
    const stmt = db.query("UPDATE substrate_issues SET deleted_at = CURRENT_TIMESTAMP, state = 'deleted' WHERE repo_slug = ? AND issue_id = ?");
    for (const row of active) {
      if (!keys.has(row.issue_id)) stmt.run(projectId, row.issue_id);
    }
  }

  private async readSnapshotIssues(): Promise<{ rows: MaterializedIssue[]; dependencies: MaterializedDependency[] }> {
    const issues = await this.ports.readSnapshot();
    const rows = issues.map((issue) => normalizeIssue(this.ports.projectId, issue, this.emitNormalize));
    return { rows, dependencies: issues.flatMap((issue) => materializeEdges(this.ports.projectId, issue)) };
  }

  private readonly emitNormalize = (repoSlug: string, issueId: string, data: Record<string, unknown>): void => {
    this.ports.emitLog?.({ component: "system", event: "beads.normalizeIssue", level: "debug", data: { repo_slug: repoSlug, issue_id: issueId, ...data } });
  };

  private async readCurrentIssues(): Promise<{ rows: MaterializedIssue[] }> {
    return { rows: this.ports.xtrmDb.query("SELECT repo_slug, issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, runtime_kind, formula_name, template_name, contract_kind, contract_xml, metadata_json, deleted_at, closed_at, close_reason, notes, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(this.ports.projectId) as MaterializedIssue[] };
  }

  private async getStoredSnapshotHash(): Promise<string | null> {
    const row = this.ports.xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(this.ports.sourceKey) as { cursor: string | null } | undefined;
    if (!row?.cursor) return null;
    try {
      const parsed = JSON.parse(row.cursor) as Partial<BeadsCursor>;
      return typeof parsed.snapshot_hash === "string" ? parsed.snapshot_hash : null;
    } catch {
      return null;
    }
  }
}

function normalizeIssue(projectId: string, issue: MaterializerBeadIssue, emitNormalize: (repoSlug: string, issueId: string, data: Record<string, unknown>) => void): MaterializedIssue {
  if (!BeadsAdapter.loggedNormalize) {
    BeadsAdapter.loggedNormalize = true;
    emitNormalize(projectId, issue.id, { priority: issue.priority, issue_type: normalizeText(issue.issue_type), labels_len: issue.labels.length, related_ids_len: issue.related_ids.length });
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const contract = extractContract(issue.description);
  const parentId = issue.parent_id ?? issue.dependencies.find((dependency) => dependency.dependency_type === "parent-child")?.id;
  return {
    repo_slug: projectId,
    issue_id: issue.id,
    title: normalizeText(issue.title),
    body: normalizeText(issue.description),
    state: issue.status === "closed" ? "closed" : issue.status,
    priority: typeof issue.priority === "number" ? issue.priority : null,
    issue_type: normalizeText(issue.issue_type),
    owner: normalizeText(issue.owner),
    labels: normalizeJson(labels),
    related_ids: normalizeJson(issue.related_ids),
    parent_id: normalizeText(parentId),
    runtime_kind: deriveRuntimeKind(issue, labels),
    formula_name: normalizeText(issue.formula_name ?? findLabelValue(labels, "formula")),
    template_name: normalizeText(issue.template_name ?? findLabelValue(labels, "template")),
    contract_kind: contract?.kind ?? null,
    contract_xml: contract?.xml ?? null,
    metadata_json: buildMetadataJson(issue, labels),
    deleted_at: null,
    closed_at: normalizeText(issue.closed_at),
    close_reason: normalizeText(issue.close_reason),
    notes: normalizeText(issue.notes),
    created_at: normalizeText(issue.created_at),
    updated_at: normalizeText(issue.updated_at),
  };
}

function materializeEdges(projectId: string, issue: MaterializerBeadIssue): MaterializedDependency[] {
  const edges = issue.dependencies.map((dependency) => ({
    repo_slug: projectId,
    issue_id: issue.id,
    dep_issue_id: dependency.id,
    relation: dependency.dependency_type,
    created_at: issue.created_at,
  }));
  if (issue.parent_id && !edges.some((edge) => edge.dep_issue_id === issue.parent_id && edge.relation === "parent-child")) {
    edges.push({
      repo_slug: projectId,
      issue_id: issue.id,
      dep_issue_id: issue.parent_id,
      relation: "parent-child",
      created_at: issue.created_at,
    });
  }
  return edges;
}

function deriveRuntimeKind(issue: MaterializerBeadIssue, labels: readonly string[]): string {
  if (normalizeText(issue.issue_type) === "molecule" || labels.includes("kind:molecule")) return "chain_molecule";
  if (labels.includes("kind:step")) return "step";
  if (normalizeText(issue.issue_type) === "epic") return "organizational_epic";
  return "root";
}

function extractContract(description: string | null): { kind: string; xml: string } | null {
  if (!description) return null;
  const match = description.match(/<(change-contract|step-contract)\b[\s\S]*?<\/\1>/);
  return match ? { kind: match[1], xml: match[0] } : null;
}

function findLabelValue(labels: readonly string[], prefix: string): string | null {
  const match = labels.find((label) => label.startsWith(`${prefix}:`));
  return match ? match.slice(prefix.length + 1) : null;
}

function buildMetadataJson(issue: MaterializerBeadIssue, labels: readonly string[]): string | null {
  const metadata: Record<string, unknown> = {};
  if (issue.metadata !== undefined) metadata.metadata = issue.metadata;
  const edgeLabels = labels.filter((label) => label.startsWith("edge:"));
  if (edgeLabels.length > 0) metadata.edge_labels = edgeLabels;
  return Object.keys(metadata).length === 0 ? null : normalizeJson(metadata);
}

function normalizeText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : stringifyBindingValue(value);
}

function normalizeJson(value: unknown): string | null {
  if (value == null) return null;
  return stringifyBindingValue(value);
}

function parseJsonArray(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeSqliteBindings(values: readonly unknown[]): Array<string | number | bigint | boolean | Uint8Array | null> {
  return values.map(normalizeSqliteValue);
}

function normalizeSqliteValue(value: unknown): string | number | bigint | boolean | Uint8Array | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value;
  return stringifyBindingValue(value);
}

function stringifyBindingValue(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) ?? String(value) : String(value);
  } catch {
    return String(value);
  }
}

function markTombstone(row: MaterializedIssue): MaterializedIssue {
  return { ...row, deleted_at: row.deleted_at ?? new Date().toISOString(), state: "deleted" };
}

function issueKey(issue: MaterializedIssue): string {
  return `${issue.repo_slug}:${issue.issue_id}`;
}

function dependencyKey(dependency: MaterializedDependency): string {
  return `${dependency.repo_slug}:${dependency.issue_id}->${dependency.dep_issue_id}:${dependency.relation}`;
}
