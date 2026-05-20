// Maps specialist roles → agent badge category (visual color), per docs/graph/reference.html
// agent palette. Roles fall into 5 buckets so the graph doesn't drown in colors.

export type AgentCategory = "exec" | "review" | "test" | "research" | "orch" | "none";

const ROLE_CATEGORY: Record<string, AgentCategory> = {
  executor: "exec",
  debugger: "exec",
  reviewer: "review",
  "code-sanity": "review",
  "security-auditor": "review",
  "test-runner": "test",
  researcher: "research",
  explorer: "research",
  overthinker: "research",
  planner: "orch",
  "node-coordinator": "orch",
  "memory-processor": "orch",
  "sync-docs": "orch",
  "changelog-keeper": "orch",
  "changelog-drafter": "orch",
  "specialists-creator": "orch",
  "xt-merge": "orch",
  chain: "exec",
  prep: "orch",
};

export function categoryFor(role: string | null | undefined): AgentCategory {
  if (!role) return "none";
  return ROLE_CATEGORY[role] ?? "none";
}

// Short job-id display: first 6 chars of the hex id.
export function shortJobId(jobId: string): string {
  return jobId.length > 6 ? jobId.slice(0, 6) : jobId;
}
