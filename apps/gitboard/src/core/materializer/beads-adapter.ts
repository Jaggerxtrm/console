import type { Database } from "bun:sqlite";
import type { BeadIssue } from "../../../../beadboard/src/types/beads.ts";
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
    this.tombstoneMissing(db, snapshot.rows);
  }

  private writeIssues(db: Database, rows: readonly MaterializedIssue[]): void {
    const stmt = db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET title=excluded.title, body=excluded.body, state=excluded.state, deleted_at=excluded.deleted_at, created_at=excluded.created_at, updated_at=excluded.updated_at");
    for (const row of rows) stmt.run(...normalizeSqliteBindings([row.repo_slug, row.issue_id, row.title, row.body, row.state, row.deleted_at, row.created_at, row.updated_at]));
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
    const keys = new Set(rows.map((row) => `${row.repo_slug}::${row.issue_id}`));
    const active = db.query("SELECT repo_slug, issue_id FROM substrate_issues WHERE deleted_at IS NULL").all() as Array<{ repo_slug: string; issue_id: string }>;
    const stmt = db.query("UPDATE substrate_issues SET deleted_at = CURRENT_TIMESTAMP, state = 'deleted' WHERE repo_slug = ? AND issue_id = ?");
    for (const row of active) {
      if (!keys.has(`${row.repo_slug}::${row.issue_id}`)) stmt.run(row.repo_slug, row.issue_id);
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
    return { rows: this.options.xtrmDb.query("SELECT repo_slug, issue_id, title, body, state, deleted_at, created_at, updated_at FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id ASC").all(this.options.projectId) as MaterializedIssue[] };
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
  return {
    repo_slug: projectId,
    issue_id: issue.id,
    title: normalizeText(issue.title),
    body: normalizeText(issue.description ?? issue.notes ?? null),
    state: issue.status === "closed" ? "closed" : issue.status,
    deleted_at: issue.status === "closed" ? normalizeText(issue.closed_at ?? issue.updated_at) : null,
    created_at: normalizeText(issue.created_at),
    updated_at: normalizeText(issue.updated_at),
  };
}

function normalizeText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : stringifyBindingValue(value);
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
