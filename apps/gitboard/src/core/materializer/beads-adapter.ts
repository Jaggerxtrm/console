import type { Database } from "bun:sqlite";
import type { BeadIssue } from "../../../../beadboard/src/types/beads.ts";
import { emit, makeLogEntry } from "../logger.ts";
import { BeadsSnapshotSource } from "./beads-snapshot-source.ts";
import { snapshotDiff, snapshotHash } from "./snapshot-diff.ts";
import type { MaterializedDependency, MaterializedIssue, MaterializerAdapter, MaterializerCursor, MaterializerDelta, MaterializerSnapshot } from "./types.ts";

export interface BeadsAdapterOptions {
  sourceKey: string;
  projectId: string;
  beadsPath: string;
  xtrmDb: Database;
  doltPort?: number;
  doltDatabase?: string;
}

type BeadsCursor = { snapshot_hash: string | null };

export class BeadsAdapter implements MaterializerAdapter<MaterializedIssue, MaterializedDependency> {
  private readonly source: BeadsSnapshotSource;
  private static loggedNormalize = false;

  constructor(private readonly options: BeadsAdapterOptions) {
    this.source = new BeadsSnapshotSource({
      sourceKey: options.sourceKey,
      beadsPath: options.beadsPath,
      doltCommitHash: null,
      xtrmDb: options.xtrmDb,
      doltClient: options.doltPort && options.doltDatabase ? createLazyDoltClient(options.doltPort, options.doltDatabase) : undefined,
    });
  }

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
    const stmt = db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET title=excluded.title, body=excluded.body, state=excluded.state, priority=excluded.priority, issue_type=excluded.issue_type, owner=excluded.owner, labels=excluded.labels, related_ids=excluded.related_ids, parent_id=excluded.parent_id, deleted_at=excluded.deleted_at, closed_at=excluded.closed_at, close_reason=excluded.close_reason, notes=excluded.notes, created_at=excluded.created_at, updated_at=excluded.updated_at");
    const counts = { rowsWithRealPriority: 0, rowsWithRealType: 0, rowsWithLabels: 0 };
    for (const row of rows) {
      if ((row.priority ?? 2) !== 2) counts.rowsWithRealPriority += 1;
      if ((row.issue_type ?? "task") !== "task") counts.rowsWithRealType += 1;
      if (parseJsonArray(row.labels).length > 0) counts.rowsWithLabels += 1;
      stmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.title, row.body, row.state, row.priority, row.issue_type, row.owner, row.labels, row.related_ids, row.parent_id, row.deleted_at, row.closed_at, row.close_reason, row.notes, row.created_at, row.updated_at]));
    }
    return counts;
  }

  private writeDependencies(db: Database, rows: readonly MaterializedDependency[]): void {
    const stmt = db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id, dep_issue_id) DO UPDATE SET relation=excluded.relation, created_at=excluded.created_at");
    for (const row of rows) stmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.dep_issue_id, row.relation, row.created_at]));
  }

  private deleteDependencies(db: Database, issues: readonly MaterializedIssue[]): void {
    const stmt = db.query("DELETE FROM substrate_dependencies WHERE repo_slug = ? AND issue_id = ?");
    for (const row of issues) stmt.run(row.repo_slug, row.issue_id);
  }

  private tombstoneMissing(db: Database, rows: readonly MaterializedIssue[]): void {
    const projectId = this.options.projectId;
    const keys = new Set(rows.filter((row) => row.repo_slug === projectId).map((row) => row.issue_id));
    const active = db.query("SELECT issue_id FROM substrate_issues WHERE deleted_at IS NULL AND repo_slug = ?").all(projectId) as Array<{ issue_id: string }>;
    const stmt = db.query("UPDATE substrate_issues SET deleted_at = CURRENT_TIMESTAMP, state = 'deleted' WHERE repo_slug = ? AND issue_id = ?");
    for (const row of active) {
      if (!keys.has(row.issue_id)) stmt.run(projectId, row.issue_id);
    }
  }

  private async readSnapshotIssues(): Promise<{ rows: MaterializedIssue[]; dependencies: MaterializedDependency[] }> {
    const issues = await this.source.readSnapshot();
    const rows = issues.map((issue) => normalizeIssue(this.options.projectId, issue));
    return { rows, dependencies: issues.flatMap((issue) => issue.dependencies.map((dependency) => ({
      repo_slug: this.options.projectId,
      issue_id: issue.id,
      dep_issue_id: dependency.id,
      relation: dependency.dependency_type,
      created_at: issue.created_at,
    }))) };
  }

  private async readCurrentIssues(): Promise<{ rows: MaterializedIssue[] }> {
    return { rows: this.options.xtrmDb.query("SELECT repo_slug, issue_id, title, body, state, priority, issue_type, owner, labels, related_ids, parent_id, deleted_at, closed_at, close_reason, notes, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(this.options.projectId) as MaterializedIssue[] };
  }

  private async getStoredSnapshotHash(): Promise<string | null> {
    const row = this.options.xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(this.options.sourceKey) as { cursor: string | null } | undefined;
    if (!row?.cursor) return null;
    try {
      const parsed = JSON.parse(row.cursor) as Partial<BeadsCursor>;
      return typeof parsed.snapshot_hash === "string" ? parsed.snapshot_hash : null;
    } catch {
      return null;
    }
  }
}

function normalizeIssue(projectId: string, issue: BeadIssue): MaterializedIssue {
  if (!BeadsAdapter.loggedNormalize) {
    BeadsAdapter.loggedNormalize = true;
    emit(makeLogEntry("system", "beads.normalizeIssue", "debug", undefined, { repo_slug: projectId, issue_id: issue.id, priority: issue.priority, issue_type: issue.issue_type, labels_len: issue.labels.length, related_ids_len: issue.related_ids.length }));
  }
  return {
    repo_slug: projectId,
    issue_id: issue.id,
    title: normalizeText(issue.title),
    body: normalizeText(issue.description),
    state: issue.status === "closed" ? "closed" : issue.status,
    priority: typeof issue.priority === "number" ? issue.priority : null,
    issue_type: normalizeText(issue.issue_type),
    owner: normalizeText(issue.owner),
    labels: normalizeJson(issue.labels),
    related_ids: normalizeJson(issue.related_ids),
    parent_id: normalizeText(issue.parent_id),
    deleted_at: null,
    closed_at: normalizeText(issue.closed_at),
    close_reason: normalizeText(issue.close_reason),
    notes: normalizeText(issue.notes),
    created_at: normalizeText(issue.created_at),
    updated_at: normalizeText(issue.updated_at),
  };
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

function createLazyDoltClient(port: number, database: string): { getIssues(options: { limit: number }): Promise<BeadIssue[]> } {
  return {
    async getIssues(options: { limit: number }): Promise<BeadIssue[]> {
      const { DoltClient } = await import("../../../../beadboard/src/core/dolt-client.ts");
      const client = new DoltClient({ host: "127.0.0.1", port, database });
      return client.getIssues(options);
    },
  };
}
