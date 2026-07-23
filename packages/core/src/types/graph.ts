import type { SourceHealth, SourceHealthFreshness } from "../state/source-health.ts";

export type GraphNodeType = "task" | "bug" | "feature" | "epic" | "chore" | "decision" | "molecule";
export type GraphNodeStatus = "open" | "in_progress" | "blocked" | "closed" | "deferred";
export type GraphEdgeType = "blocks" | "tracks" | "related" | "parent-child" | "discovered-from" | "validates" | "caused-by" | "until" | "supersedes";
export type SpecialistStatus = "starting" | "running" | "waiting" | "done" | "error" | "cancelled";
export type GraphSpecialistStatus = SpecialistStatus;

export interface GraphNode {
  id: string;
  title: string;
  type: GraphNodeType;
  priority: 0 | 1 | 2 | 3 | 4;
  status: GraphNodeStatus;
  assignee: string | null;
  closed_at: string | null;
  superseded_by: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
}

export interface GraphSpecialist {
  bead_id: string;
  job_id: string;
  role: string;
  status: SpecialistStatus;
  updated_at: string;
}

export type GraphFreshness = SourceHealthFreshness;

export interface GraphResponse {
  project_id: string;
  repo_slug: string;
  project?: string;
  generated_at: string;
  freshness?: GraphFreshness;
  source_health?: SourceHealth;
  nodes: GraphNode[];
  edges: GraphEdge[];
  specialists: GraphSpecialist[];
}
