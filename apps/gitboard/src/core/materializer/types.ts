export type MaterializerCursor = unknown;

export interface MaterializedIssue {
  repo_slug: string;
  issue_id: string;
  title?: string | null;
  body?: string | null;
  state: string;
  deleted_at?: string | null;
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

export interface MaterializerSnapshot {
  rows: readonly MaterializedIssue[];
  dependencies?: readonly MaterializedDependency[];
}

export interface MaterializerDelta extends MaterializerSnapshot {
  cursor: MaterializerCursor;
}

export interface MaterializerAdapter {
  cursor(): Promise<MaterializerCursor>;
  changesSince(cursor: MaterializerCursor): Promise<MaterializerDelta>;
  snapshot(): Promise<MaterializerSnapshot>;
}
