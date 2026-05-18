import type { Database } from "bun:sqlite";
import type { RepoStat } from "../types/github.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = any;

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

export interface EventFilters {
  repos?: string[];
  types?: string[];
  branch?: string;
  from?: string;
  to?: string;
  search?: string;
  group?: string;
  limit?: number;
  offset?: number;
}

export interface CommitFilters {
  repo?: string;
  event_id?: string;
  from?: string;
  limit?: number;
  offset?: number;
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

export function insertEvent(db: Database, event: GithubEvent): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO github_events
      (id, type, repo, branch, actor, action, title, body, url,
       additions, deletions, changed_files, commit_count, created_at)
     VALUES ($id, $type, $repo, $branch, $actor, $action, $title, $body, $url,
             $additions, $deletions, $changed_files, $commit_count, $created_at)`
  ).run({
    $id: event.id,
    $type: event.type,
    $repo: event.repo,
    $branch: event.branch,
    $actor: event.actor,
    $action: event.action,
    $title: event.title,
    $body: event.body,
    $url: event.url,
    $additions: event.additions,
    $deletions: event.deletions,
    $changed_files: event.changed_files,
    $commit_count: event.commit_count,
    $created_at: event.created_at,
  } as AnyParams);
  // bun:sqlite returns { changes: number }, node:sqlite shim returns { changes: bigint }
  const changes = (result as unknown as { changes: number | bigint }).changes;
  return Number(changes) > 0;
}

export function insertCommit(db: Database, commit: GithubCommit): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO github_commits
      (sha, repo, branch, author, message, message_full, url,
       additions, deletions, changed_files, event_id, committed_at)
     VALUES ($sha, $repo, $branch, $author, $message, $message_full, $url,
             $additions, $deletions, $changed_files, $event_id, $committed_at)`
  ).run({
    $sha: commit.sha,
    $repo: commit.repo,
    $branch: commit.branch,
    $author: commit.author,
    $message: commit.message,
    $message_full: commit.message_full ?? null,
    $url: commit.url,
    $additions: commit.additions,
    $deletions: commit.deletions,
    $changed_files: commit.changed_files,
    $event_id: commit.event_id,
    $committed_at: commit.committed_at,
  } as AnyParams);
  const changes = (result as unknown as { changes: number | bigint }).changes;
  return Number(changes) > 0;
}

export function upsertRepo(db: Database, repo: GithubRepo): void {
  db.prepare(
    `INSERT INTO github_repos
      (full_name, display_name, tracked, group_name, last_polled_at, color)
     VALUES ($full_name, $display_name, $tracked, $group_name, $last_polled_at, $color)
     ON CONFLICT(full_name) DO UPDATE SET
       display_name   = excluded.display_name,
       tracked        = excluded.tracked,
       group_name     = excluded.group_name,
       last_polled_at = excluded.last_polled_at,
       color          = excluded.color`
  ).run({
    $full_name: repo.full_name,
    $display_name: repo.display_name,
    $tracked: repo.tracked ? 1 : 0,
    $group_name: repo.group_name,
    $last_polled_at: repo.last_polled_at,
    $color: repo.color,
  } as AnyParams);
}

// Auto-discover a repo from an event. INSERT OR IGNORE so it never overwrites
// the user's tracked/group/color settings if the repo already exists.
export function ensureRepo(db: Database, fullName: string): void {
  const displayName = fullName.split("/")[1] ?? fullName;
  db.prepare(
    `INSERT OR IGNORE INTO github_repos (full_name, display_name, tracked)
     VALUES ($full_name, $display_name, 1)`
  ).run({ $full_name: fullName, $display_name: displayName } as AnyParams);
}

export function updateRepo(
  db: Database,
  fullName: string,
  fields: Partial<Pick<GithubRepo, "display_name" | "tracked" | "group_name" | "color" | "last_polled_at">>
): void {
  const sets: string[] = [];
  const params: Record<string, string | number | boolean | null | undefined> = { $full_name: fullName };

  if (fields.display_name !== undefined) {
    sets.push("display_name = $display_name");
    params.$display_name = fields.display_name;
  }
  if (fields.tracked !== undefined) {
    sets.push("tracked = $tracked");
    params.$tracked = fields.tracked ? 1 : 0;
  }
  if (fields.group_name !== undefined) {
    sets.push("group_name = $group_name");
    params.$group_name = fields.group_name;
  }
  if (fields.color !== undefined) {
    sets.push("color = $color");
    params.$color = fields.color;
  }
  if (fields.last_polled_at !== undefined) {
    sets.push("last_polled_at = $last_polled_at");
    params.$last_polled_at = fields.last_polled_at;
  }

  if (sets.length === 0) return;
  db.prepare(`UPDATE github_repos SET ${sets.join(", ")} WHERE full_name = $full_name`).run(params as AnyParams);
}

export function getEvents(db: Database, filters: EventFilters): GithubEvent[] {
  const conditions: string[] = [];
  const params: Record<string, string | number | null | undefined> = {};

  if (filters.repos && filters.repos.length > 0) {
    const placeholders = filters.repos.map((_, i) => `$repo${i}`).join(", ");
    conditions.push(`repo IN (${placeholders})`);
    filters.repos.forEach((r, i) => (params[`$repo${i}`] = r));
  }

  if (filters.types && filters.types.length > 0) {
    const placeholders = filters.types.map((_, i) => `$type${i}`).join(", ");
    conditions.push(`type IN (${placeholders})`);
    filters.types.forEach((t, i) => (params[`$type${i}`] = t));
  }

  if (filters.branch) {
    conditions.push("branch = $branch");
    params.$branch = filters.branch;
  }

  if (filters.from) {
    conditions.push("created_at >= $from");
    params.$from = filters.from;
  }

  if (filters.to) {
    conditions.push("created_at <= $to");
    params.$to = filters.to;
  }

  if (filters.search) {
    conditions.push("(title LIKE $search OR body LIKE $search)");
    params.$search = `%${filters.search}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.$limit = filters.limit ?? 50;
  params.$offset = filters.offset ?? 0;

  return db
    .query<GithubEvent, AnyParams>(
      `SELECT * FROM github_events ${where} ORDER BY created_at DESC LIMIT $limit OFFSET $offset`
    )
    .all(params);
}

export function getEvent(db: Database, id: string): GithubEvent | null {
  return (
    db.query<GithubEvent, AnyParams>("SELECT * FROM github_events WHERE id = $id").get({ $id: id }) ?? null
  );
}

export function getCommits(db: Database, filters: CommitFilters): GithubCommit[] {
  const conditions: string[] = [];
  const params: Record<string, string | number | null | undefined> = {};

  if (filters.repo) {
    conditions.push("repo = $repo");
    params.$repo = filters.repo;
  }

  if (filters.event_id) {
    conditions.push("event_id = $event_id");
    params.$event_id = filters.event_id;
  }

  if (filters.from) {
    conditions.push("committed_at >= $from");
    params.$from = filters.from;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.$limit = filters.limit ?? 50;
  params.$offset = filters.offset ?? 0;

  return db
    .query<GithubCommit, AnyParams>(
      `SELECT * FROM github_commits ${where} ORDER BY committed_at DESC LIMIT $limit OFFSET $offset`
    )
    .all(params);
}

export function getCommit(db: Database, sha: string): GithubCommit | null {
  return (
    db.query<GithubCommit, AnyParams>("SELECT * FROM github_commits WHERE sha = $sha").get({ $sha: sha }) ?? null
  );
}

export function getRepos(db: Database): GithubRepo[] {
  return db.query<GithubRepo, never[]>("SELECT * FROM github_repos ORDER BY full_name").all();
}

export interface RepoPollState {
  repo: string;
  last_issue_updated_at: string | null;
  last_pr_updated_at: string | null;
  last_activity_at: string | null;
  issue_etag: string | null;
  pr_etag: string | null;
  paused_until: string | null;
}

export function getRepoPollState(db: Database, repo: string): RepoPollState {
  return db.query<RepoPollState, AnyParams>(
    `SELECT repo, last_issue_updated_at, last_pr_updated_at, last_activity_at, issue_etag, pr_etag, paused_until
     FROM github_repo_poll_state WHERE repo = $repo`
  ).get({ $repo: repo }) ?? {
    repo,
    last_issue_updated_at: null,
    last_pr_updated_at: null,
    last_activity_at: null,
    issue_etag: null,
    pr_etag: null,
    paused_until: null,
  };
}

export function upsertRepoPollState(db: Database, state: RepoPollState): void {
  db.prepare(
    `INSERT INTO github_repo_poll_state
      (repo, last_issue_updated_at, last_pr_updated_at, last_activity_at, issue_etag, pr_etag, paused_until)
     VALUES ($repo, $last_issue_updated_at, $last_pr_updated_at, $last_activity_at, $issue_etag, $pr_etag, $paused_until)
     ON CONFLICT(repo) DO UPDATE SET
       last_issue_updated_at = excluded.last_issue_updated_at,
       last_pr_updated_at = excluded.last_pr_updated_at,
       last_activity_at = excluded.last_activity_at,
       issue_etag = excluded.issue_etag,
       pr_etag = excluded.pr_etag,
       paused_until = excluded.paused_until`
  ).run({
    $repo: state.repo,
    $last_issue_updated_at: state.last_issue_updated_at,
    $last_pr_updated_at: state.last_pr_updated_at,
    $last_activity_at: state.last_activity_at,
    $issue_etag: state.issue_etag,
    $pr_etag: state.pr_etag,
    $paused_until: state.paused_until,
  } as AnyParams);
}

export function isTruncated(msg: string): boolean {
  return msg.length >= 70 && !msg.includes('\n');
}

export function updateCommitFullMessage(db: Database, sha: string, fullMessage: string): void {
  db.prepare("UPDATE github_commits SET message_full = ? WHERE sha = ?").run(fullMessage, sha);
}

export interface EventEnrichment {
  title?: string | null;
  body?: string | null;
  url?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  commit_count?: number | null;
}

export function updateEventEnrichment(db: Database, id: string, e: EventEnrichment): void {
  db.prepare(
    `UPDATE github_events SET
       title         = COALESCE($title, title),
       body          = COALESCE($body, body),
       url           = COALESCE($url, url),
       additions     = COALESCE($additions, additions),
       deletions     = COALESCE($deletions, deletions),
       changed_files = COALESCE($changed_files, changed_files),
       commit_count  = COALESCE($commit_count, commit_count)
     WHERE id = $id`
  ).run({
    $id: id,
    $title: e.title ?? null,
    $body: e.body ?? null,
    $url: e.url ?? null,
    $additions: e.additions ?? null,
    $deletions: e.deletions ?? null,
    $changed_files: e.changed_files ?? null,
    $commit_count: e.commit_count ?? null,
  } as AnyParams);
}

export function getRepoStats(db: Database): RepoStat[] {
  return db.query<RepoStat, []>(`
    SELECT
      repo AS full_name,
      COUNT(CASE WHEN type = 'PushEvent' AND created_at > datetime('now', '-24 hours') THEN 1 END) AS pushes,
      COUNT(CASE WHEN type = 'PullRequestEvent' AND action = 'opened' AND created_at > datetime('now', '-24 hours') THEN 1 END) AS prs_open,
      COUNT(CASE WHEN type = 'PullRequestEvent' AND action IN ('closed', 'merged') AND created_at > datetime('now', '-24 hours') THEN 1 END) AS prs_closed,
      COUNT(CASE WHEN type = 'IssuesEvent' AND action = 'opened' AND created_at > datetime('now', '-24 hours') THEN 1 END) AS issues_open,
      COUNT(CASE WHEN type = 'ReleaseEvent' AND created_at > datetime('now', '-24 hours') THEN 1 END) AS releases,
      MAX(CASE WHEN type NOT IN ('WatchEvent', 'ForkEvent', 'MemberEvent') THEN created_at END) AS last_event_at
    FROM github_events
    GROUP BY repo
  `).all();
}

export async function enrichCommitMessages(
  db: Database,
  commits: GithubCommit[],
  token: string
): Promise<void> {
  const stale = commits.filter(c => c.message_full == null && isTruncated(c.message));
  if (stale.length === 0) return;

  await Promise.allSettled(stale.map(async (commit) => {
    const url = `https://api.github.com/repos/${commit.repo}/commits/${commit.sha}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return;
    const data = await res.json() as { commit: { message: string } };
    updateCommitFullMessage(db, commit.sha, data.commit.message);
    commit.message_full = data.commit.message;
  }));
}

export function getContributions(db: Database, weeks: number = 12): ContributionDay[] {
  const daysBack = weeks * 7;
  return db
    .query<ContributionDay, AnyParams>(
      `SELECT date(created_at) as date, COUNT(*) as count
       FROM github_events
       WHERE created_at >= date('now', '-' || $days || ' days')
       GROUP BY date(created_at)
       ORDER BY date ASC`
    )
    .all({ $days: daysBack });
}

export function getSummary(db: Database, period: "today" | "week" | "month"): Summary {
  const intervalMap = { today: "1 day", week: "7 days", month: "30 days" };
  const interval = intervalMap[period];

  const events =
    db
      .query<{ c: number }, AnyParams>(
        `SELECT COUNT(*) as c FROM github_events WHERE created_at >= datetime('now', '-' || $interval)`
      )
      .get({ $interval: interval })?.c ?? 0;

  const commits =
    db
      .query<{ c: number }, AnyParams>(
        `SELECT COUNT(*) as c FROM github_commits WHERE committed_at >= datetime('now', '-' || $interval)`
      )
      .get({ $interval: interval })?.c ?? 0;

  const repos =
    db
      .query<{ c: number }, never[]>("SELECT COUNT(*) as c FROM github_repos WHERE tracked = 1")
      .get()?.c ?? 0;

  const pushes =
    db
      .query<{ c: number }, AnyParams>(
        `SELECT COUNT(*) as c FROM github_events WHERE type = 'PushEvent' AND created_at >= datetime('now', '-' || $interval)`
      )
      .get({ $interval: interval })?.c ?? 0;

  const prs =
    db
      .query<{ c: number }, AnyParams>(
        `SELECT COUNT(*) as c FROM github_events WHERE type = 'PullRequestEvent' AND created_at >= datetime('now', '-' || $interval)`
      )
      .get({ $interval: interval })?.c ?? 0;

  return { events, commits, repos, pushes, prs };
}

// ─── GitHub PRs ────────────────────────────────────────────────────────────

export interface GithubPr {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string;           // 'open' | 'closed' | 'merged'
  author: string;
  url: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  comment_count: number;
  label_names: string | null;  // raw JSON array string e.g. '["bug","help wanted"]'
  created_at: string;
  updated_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
}

export interface PrFilters {
  repo?: string;
  state?: string;
  limit?: number;
  offset?: number;
}

export function upsertPr(db: Database, pr: GithubPr): void {
  db.prepare(
    `INSERT OR REPLACE INTO github_prs
      (repo, number, title, body, state, author, url,
       additions, deletions, changed_files, comment_count, label_names,
       created_at, updated_at, merged_at, closed_at)
     VALUES
      ($repo, $number, $title, $body, $state, $author, $url,
       $additions, $deletions, $changed_files, $comment_count, $label_names,
       $created_at, $updated_at, $merged_at, $closed_at)`
  ).run({
    $repo: pr.repo,
    $number: pr.number,
    $title: pr.title,
    $body: pr.body,
    $state: pr.state,
    $author: pr.author,
    $url: pr.url,
    $additions: pr.additions,
    $deletions: pr.deletions,
    $changed_files: pr.changed_files,
    $comment_count: pr.comment_count,
    $label_names: pr.label_names,
    $created_at: pr.created_at,
    $updated_at: pr.updated_at,
    $merged_at: pr.merged_at,
    $closed_at: pr.closed_at,
  } as AnyParams);
}

export function getPrs(db: Database, filters: PrFilters = {}): GithubPr[] {
  const conditions: string[] = [];
  const params: Record<string, string | number | null | undefined> = {};

  if (filters.repo) {
    conditions.push("repo = $repo");
    params.$repo = filters.repo;
  }

  if (filters.state) {
    conditions.push("state = $state");
    params.$state = filters.state;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.$limit = filters.limit ?? 100;
  params.$offset = filters.offset ?? 0;

  return db
    .query<GithubPr, AnyParams>(
      `SELECT * FROM github_prs ${where} ORDER BY updated_at DESC LIMIT $limit OFFSET $offset`
    )
    .all(params);
}

export function getPr(db: Database, repo: string, number: number): GithubPr | null {
  return (
    db
      .query<GithubPr, AnyParams>(
        "SELECT * FROM github_prs WHERE repo = $repo AND number = $number"
      )
      .get({ $repo: repo, $number: number }) ?? null
  );
}

// ─── GitHub Issues ──────────────────────────────────────────────────────────

export interface GithubIssue {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string;           // 'open' | 'closed'
  author: string;
  url: string | null;
  comment_count: number;
  label_names: string | null;  // raw JSON array string
  created_at: string;
  updated_at: string | null;
  closed_at: string | null;
}

export interface IssueFilters {
  repo?: string;
  state?: string;
  limit?: number;
  offset?: number;
}

export interface ReleaseFilters {
  repo?: string;
  limit?: number;
  offset?: number;
}

export function upsertIssue(db: Database, issue: GithubIssue): void {
  db.prepare(
    `INSERT OR REPLACE INTO github_issues
      (repo, number, title, body, state, author, url,
       comment_count, label_names, created_at, updated_at, closed_at)
     VALUES
      ($repo, $number, $title, $body, $state, $author, $url,
       $comment_count, $label_names, $created_at, $updated_at, $closed_at)`
  ).run({
    $repo: issue.repo,
    $number: issue.number,
    $title: issue.title,
    $body: issue.body,
    $state: issue.state,
    $author: issue.author,
    $url: issue.url,
    $comment_count: issue.comment_count,
    $label_names: issue.label_names,
    $created_at: issue.created_at,
    $updated_at: issue.updated_at,
    $closed_at: issue.closed_at,
  } as AnyParams);
}

export function getIssues(db: Database, filters: IssueFilters = {}): GithubIssue[] {
  const conditions: string[] = [];
  const params: Record<string, string | number | null | undefined> = {};

  if (filters.repo) {
    conditions.push("repo = $repo");
    params.$repo = filters.repo;
  }

  if (filters.state) {
    conditions.push("state = $state");
    params.$state = filters.state;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.$limit = filters.limit ?? 100;
  params.$offset = filters.offset ?? 0;

  return db
    .query<GithubIssue, AnyParams>(
      `SELECT * FROM github_issues ${where} ORDER BY updated_at DESC LIMIT $limit OFFSET $offset`
    )
    .all(params);
}

export function getIssue(db: Database, repo: string, number: number): GithubIssue | null {
  return (
    db
      .query<GithubIssue, AnyParams>(
        "SELECT * FROM github_issues WHERE repo = $repo AND number = $number"
      )
      .get({ $repo: repo, $number: number }) ?? null
  );
}

export function getReleases(db: Database, filters: ReleaseFilters = {}): GithubRelease[] {
  const conditions: string[] = ["type = 'ReleaseEvent'"];
  const params: Record<string, string | number | null | undefined> = {};

  if (filters.repo) {
    conditions.push("repo = $repo");
    params.$repo = filters.repo;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.$limit = filters.limit ?? 50;
  params.$offset = filters.offset ?? 0;

  const rows = db.query<
    { id: string; repo: string; created_at: string; body: string | null; title: string | null; url: string | null; actor: string },
    AnyParams
  >(
    `SELECT id, repo, created_at, body, title, url, actor FROM github_events ${where} ORDER BY created_at DESC LIMIT $limit OFFSET $offset`
  ).all(params);

  return rows.map((row) => ({
    id: row.id,
    tag_name: row.title ?? "",
    name: row.title,
    body: row.body,
    html_url: row.url,
    author_login: row.actor,
    published_at: row.created_at,
    repo_full_name: row.repo,
  }));
}
