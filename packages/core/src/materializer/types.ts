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
  runtime_kind?: string | null;
  formula_name?: string | null;
  template_name?: string | null;
  contract_kind?: string | null;
  contract_xml?: string | null;
  metadata_json?: string | null;
  deleted_at?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
  notes?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MaterializedSpecialistJob {
  repo_slug: string;
  job_id: string;
  bead_id?: string | null;
  specialist: string;
  status: string;
  chain_id?: string | null;
  epic_id?: string | null;
  chain_kind?: string | null;
  worktree?: string | null;
  last_output?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  updated_at_ms?: number | null;
  turns?: number | null;
  tools?: number | null;
  model?: string | null;
  token_input?: number | null;
  token_output?: number | null;
  token_cache_read?: number | null;
  token_cache_creation?: number | null;
  token_reasoning?: number | null;
  token_tool?: number | null;
  usage_source?: string | null;
}

export interface MaterializedDependency {
  repo_slug: string;
  issue_id: string;
  dep_issue_id: string;
  relation: string;
  created_at?: string | null;
}

export interface MaterializedForensicEvent {
  source_key: string;
  source_event_id: string;
  repo_slug: string;
  job_id?: string | null;
  seq?: number | null;
  t_unix_ms?: number | null;
  timestamp?: string | null;
  schema_version: string;
  severity?: string | null;
  event_family?: string | null;
  event_name?: string | null;
  event_version?: number | null;
  resource_json: string;
  correlation_json: string;
  body_json: string;
  redaction_json: string;
  trace_json?: string | null;
  links_json?: string | null;
  diagnostics_json?: string | null;
  envelope_json: string;
}

export interface MaterializedEvidenceRef {
  source_key: string;
  repo_slug: string;
  evidence_id: string;
  evidence_kind: string;
  job_id?: string | null;
  issue_id?: string | null;
  event_source_id?: string | null;
  ref_json: string;
  created_at?: string | null;
}

export interface MaterializerSnapshot<TRow = MaterializedIssue, TDependency = MaterializedDependency> {
  rows: readonly TRow[];
  dependencies?: readonly TDependency[];
  forensicEvents?: readonly MaterializedForensicEvent[];
  evidenceRefs?: readonly MaterializedEvidenceRef[];
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
  writeFull?(db: Database, snapshot: MaterializerSnapshot<TRow, TDependency>): void;
}
