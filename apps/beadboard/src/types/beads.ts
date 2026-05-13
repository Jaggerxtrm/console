// Beadboard domain types

export type Status = "open" | "in_progress" | "blocked" | "in_review" | "closed" | (string & {});
export type Priority = 0 | 1 | 2 | 3 | 4 | (number & {});
export type IssueType = "bug" | "feature" | "task" | "epic" | "chore" | (string & {});
export type ProjectSourceKind = "dolt" | "sqlite" | "jsonl" | "unknown";
export type ProjectSourceState = "available" | "missing" | "unhealthy";

export interface ProjectSourceHealth {
  kind: ProjectSourceKind;
  state: ProjectSourceState;
  path?: string;
  detail?: string;
}

export interface BeadsProject {
  id: string;
  name: string;
  path: string;
  beadsPath: string;
  doltPort?: number;
  doltDatabase?: string;
  source?: ProjectSourceKind;
  sourceHealth?: ProjectSourceHealth[];
  sourcePriority?: ProjectSourceKind[];
  status: "active" | "idle" | "error";
  lastScanned: string;
  issueCount: number;
}

export interface BeadIssue {
  id: string;
  title: string;
  description: string | null;
  notes?: string | null;
  status: Status;
  priority: Priority;
  issue_type: IssueType;
  owner: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  project_id: string;
  dependencies: BeadDependency[];
  parent_id?: string;
  related_ids: string[];
  labels: string[];
}

export interface BeadIssueDetail extends BeadIssue {
  dependents: BeadDependency[];
  children?: BeadDependency[];
  source: ProjectSourceKind;
  sourceHealth: ProjectSourceHealth[];
}

export interface BeadDependency {
  id: string;
  title: string;
  status: Status;
  dependency_type: "blocks" | "blocked_by" | "related" | "parent" | "parent-child" | (string & {});
}

export interface Memory {
  id: string;
  content: string;
  type: "learned" | "investigation" | "decision";
  tags: string[];
  created_at: string;
  issue_id?: string;
  project_id: string;
}

export interface Interaction {
  id: string;
  kind: "tool_call" | "comment" | "status_change";
  created_at: string;
  actor: string;
  issue_id: string;
  model?: string;
  tool_name?: string;
  exit_code?: number;
  project_id: string;
}

export interface AgentSession {
  id: string;
  agent: "claude" | "pi" | "qwen" | "gemini" | "other";
  model?: string;
  started_at: string;
  ended_at?: string;
  issue_ids: string[];
  tool_calls: number;
  files_modified?: string[];
  project_id: string;
}

// API types
export interface IssueFilters {
  project_id?: string;
  status?: Status[];
  priority?: Priority[];
  issue_type?: IssueType[];
  search?: string;
  limit?: number;
  offset?: number;
}
