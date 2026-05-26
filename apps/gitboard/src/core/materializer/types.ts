import type { Database } from "bun:sqlite";

export type MaterializerCursor = unknown;

export interface MaterializedIssue {
  repo_slug: string;
  issue_id: string;
  title?: string | null;
  body?: string | null;
  state: string;
  priority?: number | null;
  issue_type?: string | null;
  owner?: string | null;
  labels?: string | null;
  related_ids?: string | null;
  parent_id?: string | null;
  deleted_at?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MaterializedDependency {
  repo_slug: string;
  issue_id: string;
  dep_issue_id: string;
  relation: string;
  created_at?: string | null;
}

export interface MaterializerSnapshot<TRow = MaterializedIssue, TDependency = MaterializedDependency> {
  rows: readonly TRow[];
  dependencies?: readonly TDependency[];
}

export interface MaterializerDelta<TRow = MaterializedIssue, TDependency = MaterializedDependency>
  extends MaterializerSnapshot<TRow, TDependency> {
  cursor: MaterializerCursor;
}

export interface MaterializerAdapter<TRow = MaterializedIssue, TDependency = MaterializedDependency> {
  cursor(): Promise<MaterializerCursor>;
  changesSince(cursor: MaterializerCursor): Promise<MaterializerDelta<TRow, TDependency>>;
  snapshot(): Promise<MaterializerSnapshot<TRow, TDependency>>;
  write(db: Database, snapshot: MaterializerSnapshot<TRow, TDependency>): void;
}
