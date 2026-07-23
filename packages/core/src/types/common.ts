// Domain types for Omniforge

export type Status = "open" | "in_progress" | "blocked" | "in_review" | "closed";
export type Priority = 0 | 1 | 2 | 3 | 4;
export type IssueType = "bug" | "feature" | "task" | "epic" | "chore";

export type ID = string;
export type Timestamp = string;

export interface BeadIssue {
  id: ID;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  issue_type: IssueType;
  owner: string | null;
  created_at: Timestamp;
  created_by: string | null;
  updated_at: Timestamp;
  closed_at?: Timestamp;
  close_reason?: string;
  dependencies: BeadDependency[];
  parent_id?: ID;
  related_ids: ID[];
  linkedPrs: LinkedPr[];
  agentSessions: AgentSession[];
  labels: string[];
}

export interface BeadDependency {
  id: ID;
  title: string;
  status: Status;
  dependency_type: "blocks" | "blocked_by" | "related" | "parent";
}

export interface LinkedPr {
  repo: string;
  number: number;
  state: "open" | "closed" | "merged";
  url: string;
  title?: string;
  worktree_path?: string;
  merged_at?: Timestamp;
  additions?: number;
  deletions?: number;
}

export interface AgentSession {
  id: ID;
  agent: "claude" | "pi" | "qwen" | "gemini" | "other";
  model?: string;
  started_at: Timestamp;
  ended_at?: Timestamp;
  issue_ids: ID[];
  tool_calls: number;
  files_modified?: string[];
}

export interface Memory {
  id: ID;
  content: string;
  type: "learned" | "investigation" | "decision";
  tags: string[];
  created_at: Timestamp;
  issue_id?: ID;
}

export interface GithubEvent {
  id: ID;
  type: string;
  repo: string;
  branch: string | null;
  actor: string;
  action: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  commit_count: number | null;
  created_at: Timestamp;
}

export interface GithubCommit {
  sha: string;
  repo: string;
  branch: string | null;
  author: string;
  message: string;
  message_full?: string | null;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  event_id: string | null;
  committed_at: Timestamp;
}

export interface GithubRepo {
  full_name: string;
  display_name: string | null;
  tracked: boolean;
  group_name: string | null;
  last_polled_at: string | null;
  color: string | null;
}

export interface RepoStat {
  full_name: string;
  pushes: number;
  prs_open: number;
  prs_closed: number;
  last_event_at: string | null;
}

export interface ContributionDay {
  date: string;
  count: number;
}

export interface Summary {
  events: number;
  commits: number;
  repos: number;
  pushes: number;
  prs: number;
}
