export interface GithubEvent {
  id: string;
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
  created_at: string;
  ingested_at?: string;
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
  committed_at: string;
}

export interface GithubRepo {
  full_name: string;
  display_name: string | null;
  tracked: boolean;
  group_name: string | null;
  last_polled_at: string | null;
  color: string | null;
}

export interface ContributionDay {
  date: string;
  count: number;
}

export interface Summary {
  events: number;
  pushes: number;
  prs: number;
  commits: number;
  repos: number;
}

export interface RepoStat {
  full_name: string;
  pushes: number;
  prs_open: number;
  prs_closed: number;
  issues_open: number;
  releases: number;
  last_event_at: string | null;
}

export interface RepoStatsResponse {
  data: RepoStat[];
}

export interface EventsResponse {
  data: GithubEvent[];
  limit: number;
  offset: number;
}

export interface CommitsResponse {
  data: GithubCommit[];
  limit: number;
  offset: number;
}

export interface ReposResponse {
  data: GithubRepo[];
}

export interface ContributionsResponse {
  data: ContributionDay[];
}

export type EventFilter = {
  repos?: string[];
  types?: string[];
  branch?: string;
  from?: string;
  to?: string;
  search?: string;
  group?: string;
  limit?: number;
  offset?: number;
};

export interface GithubPr {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string; // 'open' | 'closed' | 'merged'
  author: string;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  comment_count: number;
  label_names: string | null; // raw JSON array string e.g. '["bug","help wanted"]'
  created_at: string;
  updated_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
}

export interface GithubRelease {
  id: string;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string | null;
  author_login: string;
  published_at: string;
  repo_full_name: string;
}

export interface GithubPrComment {
  id: number;
  author: string;
  author_avatar_url: string | null;
  author_association: string | null;
  body: string;
  url: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface GithubPrReview {
  id: number;
  author: string;
  author_avatar_url: string | null;
  author_association: string | null;
  state: string;
  body: string | null;
  url: string | null;
  commit_id: string | null;
  submitted_at: string | null;
}

export interface GithubPrTimelineEventData {
  label?: { name: string; color: string | null };
  assignee?: { login: string; avatar_url: string | null };
  requested_reviewer?: { login: string; avatar_url: string | null } | null;
  requested_team?: { slug: string; name: string | null } | null;
  from?: string | null;
  to?: string | null;
  source?: { type: string | null; repo: string | null; number: number | null; title: string | null; url: string | null; state: string | null };
  before?: string | null;
  after?: string | null;
  ref?: string | null;
  commit_id?: string | null;
}

export interface GithubPrTimelineEvent {
  id: string;
  event: string;
  actor: string | null;
  body?: string | null;
  commit_id?: string | null;
  state?: string | null;
  url?: string | null;
  data?: GithubPrTimelineEventData | null;
  created_at: string;
}

export interface GithubPrLiveDetails {
  head_ref: string | null;
  head_sha: string | null;
  base_ref: string | null;
  base_sha: string | null;
  draft: boolean | null;
  merged_by: { login: string; avatar_url: string | null } | null;
  author_avatar_url: string | null;
  assignees: Array<{ login: string; avatar_url: string | null }>;
  requested_reviewers: Array<{ login: string; avatar_url: string | null }>;
  requested_teams: Array<{ slug: string; name: string | null }>;
  milestone: { title: string; url: string | null; due_on: string | null } | null;
  labels: Array<{ name: string; color: string | null; description: string | null }>;
}

export interface GithubPrReviewComment {
  id: number;
  author: string;
  author_avatar_url: string | null;
  body: string;
  path: string | null;
  line: number | null;
  diff_hunk: string | null;
  url: string | null;
  in_reply_to_id: number | null;
  pull_request_review_id: number | null;
  original_line: number | null;
  start_line: number | null;
  original_start_line: number | null;
  side: string | null;
  commit_id: string | null;
  original_commit_id: string | null;
  subject_type: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface GithubPrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
}

export interface GithubPrDetail {
  pr: GithubPr & GithubPrLiveDetails;
  comments: GithubPrComment[];
  reviews: GithubPrReview[];
  review_comments: GithubPrReviewComment[];
  commits: Array<{
    sha: string;
    message: string;
    author: string;
    author_login: string | null;
    author_avatar_url: string | null;
    verified: boolean | null;
    url: string | null;
    committed_at: string;
  }>;
  files: GithubPrFile[];
  timeline: GithubPrTimelineEvent[];
  errors?: Record<string, string>;
}

export interface GithubIssue {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string; // 'open' | 'closed'
  author: string;
  url: string | null;
  comment_count: number;
  label_names: string | null; // raw JSON array string
  created_at: string;
  updated_at: string | null;
  closed_at: string | null;
}

export interface PrsResponse {
  data: GithubPr[];
  limit: number;
  offset: number;
}

export interface IssuesResponse {
  data: GithubIssue[];
  limit: number;
  offset: number;
}
