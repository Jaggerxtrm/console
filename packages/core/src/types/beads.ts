import type { SourceHealthStatus } from "../state/source-health.ts";

export type Status = "open" | "in_progress" | "blocked" | "in_review" | "closed" | (string & {});
export type Priority = 0 | 1 | 2 | 3 | 4 | (number & {});
export type IssueType = "bug" | "feature" | "task" | "epic" | "chore" | (string & {});
export type ProjectSourceKind = "dolt" | "sqlite" | "jsonl" | "unknown";
export type ProjectSourceState = SourceHealthStatus;

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
  assignee?: string;
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
  metadata?: unknown;
  formula_name?: string;
  template_name?: string;
  linkedPrs?: LinkedPr[];
  agentSessions?: AgentSession[];
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
  issue_type?: IssueType;
  dependency_type: "blocks" | "blocked_by" | "tracks" | "related" | "relates-to" | "parent" | "parent-child" | "discovered-from" | "until" | "caused-by" | "validates" | "supersedes" | (string & {});
}

export interface LinkedPr {
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
  url: string;
  title?: string;
  worktree_path?: string;
  merged_at?: string;
  additions?: number;
  deletions?: number;
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

export interface IssueFilters {
  project_id?: string;
  status?: Status[];
  priority?: Priority[];
  issue_type?: IssueType[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface BeadsConnectionStatus {
  source?: "dolt" | "jsonl" | "none" | string;
  status: "dolt_connected" | "dolt_missing_config" | "dolt_process_dead" | "dolt_unreachable" | "dolt_query_failed" | "connected" | "jsonl_fallback" | "no_dolt" | "not_found" | "error" | string;
  degraded?: boolean;
  health?: SourceHealthStatus;
  message?: string;
  port?: number;
  pid?: number;
  database?: string;
  note?: string;
  error?: string;
}

export interface BeadsStats {
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
  last_activity_at: string | null;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
}
