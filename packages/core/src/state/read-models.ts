export type ReadModelDomain = "substrate" | "specialists" | "feed" | "graph" | "source-health";
export type ReadModelSourceKind = "native-domain-state" | "derived-projection" | "legacy-bridge" | "durable-external-adapter";

export interface ReadModelEntity {
  name: string;
  source: ReadModelSourceKind;
  fields: readonly string[];
  legacyTables?: readonly string[];
  notes?: string;
}

export interface ConsoleReadModelContract {
  id: string;
  version: 1;
  domain: ReadModelDomain;
  currentRoutes: readonly string[];
  entities: readonly ReadModelEntity[];
  invariants: readonly string[];
  droppableBridgeFields: readonly string[];
}

export function createConsoleReadModelContracts(): ConsoleReadModelContract[] {
  return [
    {
      id: "substrate.issue-graph",
      version: 1,
      domain: "substrate",
      currentRoutes: [
        "/api/substrate/projects",
        "/api/substrate/projects/:projectId/issues",
        "/api/substrate/projects/:projectId/issues/:issueId",
        "/api/substrate/projects/:projectId/runtime-graph",
        "/api/substrate/projects/:projectId/stats",
      ],
      entities: [
        {
          name: "Issue",
          source: "native-domain-state",
          fields: ["repo_slug", "issue_id", "title", "body", "state", "priority", "issue_type", "owner", "labels", "parent_id", "created_at", "updated_at", "closed_at"],
          legacyTables: ["substrate_issues"],
        },
        {
          name: "IssueEdge",
          source: "derived-projection",
          fields: ["repo_slug", "from_issue_id", "to_issue_id", "relation", "created_at"],
          legacyTables: ["substrate_dependencies", "substrate_issue_edges"],
        },
      ],
      invariants: ["Issue IDs remain opaque strings.", "Parent/child and dependency relations are edge records, not cross-domain foreign keys."],
      droppableBridgeFields: ["runtime_kind", "formula_name", "template_name", "contract_kind", "contract_xml"],
    },
    {
      id: "specialists.activity-evidence",
      version: 1,
      domain: "specialists",
      currentRoutes: [
        "/api/specialists/jobs",
        "/api/specialists/jobs/in-flight",
        "/api/specialists/chains/:chainId",
        "/api/specialists/jobs/:job_id/feed-events",
      ],
      entities: [
        {
          name: "SpecialistJob",
          source: "native-domain-state",
          fields: ["repo_slug", "job_id", "bead_id", "specialist", "status", "chain_id", "epic_id", "worktree", "last_output", "updated_at_ms", "model", "token_input", "token_output"],
          legacyTables: ["specialist_jobs"],
        },
        {
          name: "ForensicEvent",
          source: "derived-projection",
          fields: ["source_key", "source_event_id", "repo_slug", "job_id", "seq", "t_unix_ms", "schema_version", "event_name", "body_json", "envelope_json"],
          legacyTables: ["xtrm_forensic_events"],
        },
        {
          name: "EvidenceRef",
          source: "derived-projection",
          fields: ["source_key", "repo_slug", "evidence_id", "evidence_kind", "job_id", "issue_id", "ref_json"],
          legacyTables: ["xtrm_evidence_refs"],
        },
      ],
      invariants: ["Evidence drilldowns keep forensic event IDs and evidence IDs stable.", "Specialist jobs correlate to beads by opaque bead_id only."],
      droppableBridgeFields: ["usage_source"],
    },
    {
      id: "feed.rollups",
      version: 1,
      domain: "feed",
      currentRoutes: ["/api/feed"],
      entities: [
        {
          name: "FeedRollup",
          source: "derived-projection",
          fields: ["id", "source", "kind", "repo_slug", "title", "summary", "t_unix_ms", "seq", "severity", "status", "redaction_status", "drilldown"],
        },
      ],
      invariants: ["Feed remains cursor-paginated by t_unix_ms, seq, and id.", "Feed rows expose drilldown pointers, never raw forensic envelopes."],
      droppableBridgeFields: [],
    },
    {
      id: "graph.console-joins",
      version: 1,
      domain: "graph",
      currentRoutes: ["/api/console/graph"],
      entities: [
        {
          name: "GraphNode",
          source: "derived-projection",
          fields: ["id", "label", "type", "status", "priority", "repoSlug", "issueId"],
        },
        {
          name: "GraphEdge",
          source: "derived-projection",
          fields: ["id", "source", "target", "type"],
        },
        {
          name: "GraphSpecialist",
          source: "derived-projection",
          fields: ["jobId", "beadId", "status", "specialist", "repoSlug"],
        },
      ],
      invariants: ["Graph joins must tolerate missing cross-domain records.", "Closed issue inclusion remains an explicit query option."],
      droppableBridgeFields: [],
    },
    {
      id: "source-health.freshness",
      version: 1,
      domain: "source-health",
      currentRoutes: ["/api/substrate/projects/:projectId/connection", "/api/sources", "/api/console/graph", "/api/specialists/jobs/in-flight"],
      entities: [
        {
          name: "SourceHealth",
          source: "native-domain-state",
          fields: ["kind", "status", "message", "metadata", "last_success_at", "last_error"],
          legacyTables: ["sources", "materialization_state"],
        },
      ],
      invariants: ["Source health may report degraded while stale read models remain queryable.", "Internal paths and source keys are redacted from user-facing health where required."],
      droppableBridgeFields: [],
    },
  ];
}

export function findConsoleReadModelByRoute(route: string): ConsoleReadModelContract | undefined {
  return createConsoleReadModelContracts().find((contract) => contract.currentRoutes.some((currentRoute) => routeMatches(currentRoute, route)));
}

function routeMatches(pattern: string, route: string): boolean {
  const patternParts = pattern.split("/");
  const routeParts = route.split("/");
  if (patternParts.length !== routeParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(":") || part === routeParts[index]);
}
