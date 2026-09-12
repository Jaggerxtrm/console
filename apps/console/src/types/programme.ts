// Mercury programme read model types (schema v3 after state/history enrichment).
// Mirrors the canonical dashboard read model produced by mercuryintelligence/program
// `dashboard/build_snapshot.py` + `dashboard/enrich_snapshot.py` (PR #118, merged at
// 159e3b5f). Consumed by the server-side builder and the /console/programme UI.

export interface ProgrammeEdge {
  source: string;
  target: string;
  relation: string;
  field: string;
  strength: "strong" | "weak";
}

export interface ProgrammeNode {
  id: string;
  kind: string;
  title: string;
  status?: string | null;
  source_path?: string | null;
  metadata?: Record<string, unknown>;
  metadata_tree?: unknown;
}

export interface IdentityCollision {
  id: string;
  kind: string;
  records: string[];
}

export interface ProgrammeGraph {
  nodes: ProgrammeNode[];
  edges: ProgrammeEdge[];
  metadata_fields: Array<{ path: string; records: number }>;
  identity_collisions: IdentityCollision[];
}

export interface ProgrammeWorkstream {
  id: string;
  graph_id: string;
  title: string;
  status: string;
  path: string;
  state_path?: string | null;
  plan_path?: string | null;
  has_plan: boolean;
  jira_refs: string[];
  portfolio_issue?: string | null;
  current_assignment?: string | null;
  updated_at?: string | null;
  metadata: Record<string, unknown>;
  metadata_tree: unknown;
}

export interface ProgrammeAssignment {
  id: string;
  graph_id: string;
  kind: string;
  title: string;
  status: string;
  authority?: unknown;
  workstream?: unknown;
  jira_refs: string[];
  path: string;
  updated_at?: string | null;
  identity_collision: boolean;
  metadata: Record<string, unknown>;
  metadata_tree: unknown;
}

export interface ProgrammeGoverned {
  id: string;
  graph_id: string;
  title: string;
  status: string;
  authority?: unknown;
  jira_refs: string[];
  path: string;
  updated_at?: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  metadata_tree: unknown;
}

export interface ProgrammeAgent {
  id: string;
  graph_id: string;
  title: string;
  status: string;
  role: string;
  path: string;
  updated_at?: string | null;
  metadata: Record<string, unknown>;
  metadata_tree: unknown;
}

export interface ProgrammeActivity {
  sha: string;
  date: string;
  subject: string;
  url: string;
}

export interface ProgrammeRef {
  key: string;
  seen_in: string[];
}

export interface ProgrammeBusiness {
  target_customers?: number | null;
  baseline_customers?: number | null;
  deadline?: string | null;
  evidence_note?: string | null;
  source?: string | null;
  baseline_evidence_class?: string | null;
  baseline_source?: string | null;
}

export interface ProgrammeNow {
  title: string;
  evidence_cutoff?: string | null;
  path: string;
}

export interface StateRecord {
  id: string;
  kind: "state";
  title: string;
  status: string;
  actor_id?: string | null;
  assignment_id?: string | null;
  updated_at?: string | null;
  path: string;
  metadata_tree: unknown;
}

export interface JournalRecord {
  id: string;
  kind: "journal";
  title: string;
  date?: string | null;
  evidence_cutoff?: string | null;
  classification?: string | null;
  publication?: string | null;
  authority_class: string;
  refs: string[];
  path: string;
}

export interface PublicationRecord {
  id: string;
  kind: "publication";
  title: string;
  run_date: string;
  slot: string;
  assignment_id?: string | null;
  branch?: string | null;
  pull_request?: string | null;
  review?: unknown;
  execution_status?: unknown;
  source_path: string;
  evidence_class: string;
  logical_actor: "UNKNOWN";
  principal_set: "UNKNOWN";
}

export interface ProgrammeProvenance {
  current: {
    programme_actor_registry: boolean;
    state_actor_assignment_fields: boolean;
    wrapper_publication_facts: boolean;
    xtrm_mutation_receipts: boolean;
  };
  rules: string[];
  live_receipt_gate: string;
}

export interface ProgrammeStateHistorySemantics {
  current_state_precedence: string;
  journal_authority: string;
  publication_separation: string;
  unsafe_nested_relationship_policy: string;
  suppressed_unsafe_nested_edges: number;
}

export interface ProgrammeSourceHealth {
  source: string;
  status: "fresh" | "stale" | "degraded" | "unhealthy" | "missing" | "unknown";
  checked_at: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgrammeSnapshot {
  schema_version: number;
  base_schema_version?: number;
  generated_at: string;
  programme: {
    repository: string;
    branch: string;
    sha?: string | null;
    short_sha?: string | null;
  };
  now: ProgrammeNow;
  business: ProgrammeBusiness;
  workstreams: ProgrammeWorkstream[];
  assignments: ProgrammeAssignment[];
  research: ProgrammeGoverned[];
  decisions: ProgrammeGoverned[];
  proposals: ProgrammeGoverned[];
  agents: ProgrammeAgent[];
  jira_refs: ProgrammeRef[];
  operator_input_refs: string[];
  activity: ProgrammeActivity[];
  graph: ProgrammeGraph;
  identity_collisions: IdentityCollision[];
  evidence_boundary: Record<string, string>;
  state_records: StateRecord[];
  journals: JournalRecord[];
  publication_facts: PublicationRecord[];
  state_history_semantics: ProgrammeStateHistorySemantics;
  provenance: ProgrammeProvenance;
  source_health: ProgrammeSourceHealth;
}

export interface ProgrammeSnapshotResponse {
  snapshot: ProgrammeSnapshot | null;
  freshness: "fresh" | "stale" | "degraded";
  source_health: ProgrammeSourceHealth;
  error?: string | null;
  /** Present when the router can compare against a previously built snapshot. */
  changes_summary?: ProgrammeChangesSummary | null;
}

/** Cheap per-snapshot change summary included in the main response so list/card
 * views can render Δ chips without a second request. */
export interface ProgrammeChangesSummary {
  previous_sha: string | null;
  current_sha: string | null;
  changed_entities: number;
  changed_entity_keys: string[];
  changed_relations: number;
}

/** One changed field of an entity between two observed snapshots. */
export interface ProgrammeFieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
  previous?: unknown;
  current?: unknown;
}

/** One relation (edge) difference of an entity between two observed snapshots. */
export interface ProgrammeRelationChange {
  source: string;
  target: string;
  relation: string;
  field: string;
  strength: "strong" | "weak";
  kind: "added" | "removed";
}

/** One observed status transition for an entity (from observed snapshots only). */
export interface ProgrammeStatusTrailEntry {
  sha: string | null;
  date: string;
  status: string | null;
}

/** Collision-safe per-entity change record. */
export interface ProgrammeEntityChange {
  entity_key: string;
  display_id: string;
  kind: string;
  title: string;
  path: string | null;
  field_changes: ProgrammeFieldChange[];
  relation_changes: ProgrammeRelationChange[];
  status_trail: ProgrammeStatusTrailEntry[];
  previous_revision_sha: string | null;
  current_revision_sha: string | null;
}

/** Deterministic diff between the two most recently observed snapshots. */
export interface ProgrammeChangeSet {
  previous_sha: string | null;
  current_sha: string | null;
  generated_at: string;
  entities: ProgrammeEntityChange[];
  relation_count: number;
}

/** One git revision touching an entity's canonical source path. */
export interface ProgrammeRevision {
  sha: string;
  date: string;
  subject: string;
  url: string;
}

/** Per-entity revision history (meaningful file-level revisions). */
export interface ProgrammeRevisionHistory {
  entity_key: string;
  path: string;
  revisions: ProgrammeRevision[];
  current_revision_sha: string | null;
  previous_revision_sha: string | null;
}
