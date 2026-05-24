import type { Database } from "bun:sqlite";
import type { BeadIssue } from "../../../../beadboard/src/types/beads.ts";
import { BeadsSnapshotSource } from "./beads-snapshot-source.ts";
import { snapshotDiff, snapshotHash } from "./snapshot-diff.ts";
import type { MaterializerAdapter, MaterializerCursor, MaterializerDelta, MaterializerSnapshot, MaterializedDependency, MaterializedIssue } from "./types.ts";

export interface BeadsAdapterOptions {
  sourceKey: string;
  projectId: string;
  beadsPath: string;
  xtrmDb: Database;
  doltPort?: number;
  doltDatabase?: string;
}

type BeadsCursor = { snapshot_hash: string | null };

export class BeadsAdapter implements MaterializerAdapter {
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

  async changesSince(): Promise<MaterializerDelta> {
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

  async snapshot(): Promise<MaterializerSnapshot> {
    return this.readSnapshotIssues();
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
    title: issue.title,
    body: issue.description ?? issue.notes ?? null,
    state: issue.status === "closed" ? "closed" : issue.status,
    deleted_at: issue.status === "closed" ? issue.closed_at ?? issue.updated_at : null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
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
