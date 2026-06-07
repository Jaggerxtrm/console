import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  insertEvent,
  insertCommit,
  ensureRepo,
  updateEventEnrichment,
  upsertPr,
  upsertIssue,
  upsertRelease,
  getRepos,
  getRepoPollState,
  upsertRepoPollState,
} from "./github-store.ts";
import type { GithubEvent, GithubCommit, GithubPr, GithubIssue, GithubRepo, GithubRelease } from "./github-store.ts";
import type { ChannelRegistry } from "../api/ws/channels.ts";
import type { GithubRealtimeEvent, GithubSourceHealth } from "../types/realtime.ts";
import type { SourceHealth } from "../types/source-health.ts";
import { makeSourceHealth } from "../types/source-health.ts";
import { emit, makeLogEntry } from "./logger.ts";

export interface RawGithubCommit {
  sha: string;
  message: string;
  author: { name: string };
  url: string;
}

export interface RawGithubEvent {
  id: string;
  type: string;
  repo: { name: string };
  actor: { login: string };
  created_at: string;
  payload: Record<string, unknown>;
}

export interface PollerOptions {
  intervalMs?: number;
  backfillPages?: number;
  registry?: ChannelRegistry;
  repoConcurrency?: number;
}

interface ApiGetResult<T> {
  data: T | null;
  status: "ok" | "not_modified" | "error";
  etag: string | null;
}

type RateLimitSnapshot = {
  remaining: number;
  limit: number;
  reset_at: string;
};

interface RepoEndpointPollResult {
  watermark: string | null;
  etag: string | null;
  successful: boolean;
}

export function getGithubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const result = Bun.spawnSync(["gh", "auth", "token"]);
  if (result.exitCode === 0) return result.stdout.toString().trim();
  throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
}

export async function getAuthenticatedUsername(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "agent-forge/0.1.0",
    },
  });
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: /user`);
  const user = await response.json() as { login: string };
  return user.login;
}

export function transformEvent(raw: RawGithubEvent): GithubEvent {
  const payload = raw.payload;
  const repo = raw.repo.name;
  const actor = raw.actor.login;

  let branch: string | null = null;
  let action: string | null = null;
  let title: string | null = null;
  let body: string | null = null;
  let url: string | null = null;
  let additions: number | null = null;
  let deletions: number | null = null;
  let changed_files: number | null = null;
  let commit_count: number | null = null;

  if (payload.action && typeof payload.action === "string") {
    action = payload.action;
  }

  switch (raw.type) {
    case "PushEvent": {
      const ref = payload.ref as string | undefined;
      branch = ref ? ref.replace("refs/heads/", "") : null;
      const commits = payload.commits as RawGithubCommit[] | undefined;
      // Use null (not 0) when size is absent — avoids showing "0 commits" for unknown data.
      // Genuine 0-commit pushes (branch deletions etc.) still get size=0 from the API.
      commit_count = (payload.size as number | undefined) ?? commits?.length ?? null;
      title = commits?.[0]?.message?.split("\n")[0] ?? null;
      break;
    }
    case "PullRequestEvent": {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (pr) {
        title = (pr.title as string | undefined) ?? null;
        body = (pr.body as string | undefined) ?? null;
        url = (pr.html_url as string | undefined) ?? null;
        additions = (pr.additions as number | undefined) ?? null;
        deletions = (pr.deletions as number | undefined) ?? null;
        changed_files = (pr.changed_files as number | undefined) ?? null;
      }
      break;
    }
    case "IssueCommentEvent":
    case "IssueEvent": {
      const issue = payload.issue as Record<string, unknown> | undefined;
      if (issue) {
        title = (issue.title as string | undefined) ?? null;
        url = (issue.html_url as string | undefined) ?? null;
      }
      break;
    }
    case "PullRequestReviewEvent": {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (pr) {
        title = (pr.title as string | undefined) ?? null;
        url = (pr.html_url as string | undefined) ?? null;
      }
      break;
    }
    case "CreateEvent": {
      const ref_type = payload.ref_type as string | undefined;
      const ref = payload.ref as string | undefined;
      if (ref_type === "branch") branch = ref ?? null;
      title = ref ? `Created ${ref_type}: ${ref}` : `Created ${ref_type}`;
      break;
    }
    case "ReleaseEvent": {
      const release = payload.release as Record<string, unknown> | undefined;
      if (release) {
        title = (release.name as string | undefined) ?? (release.tag_name as string | undefined) ?? null;
        body = (release.body as string | undefined) ?? null;
        url = (release.html_url as string | undefined) ?? null;
      }
      break;
    }
  }

  return {
    id: raw.id,
    type: raw.type,
    repo,
    branch,
    actor,
    action,
    title,
    body,
    url,
    additions,
    deletions,
    changed_files,
    commit_count,
    created_at: raw.created_at,
  };
}

export function transformCommits(raw: RawGithubEvent): GithubCommit[] {
  if (raw.type !== "PushEvent") return [];

  const payload = raw.payload;
  const commits = payload.commits as RawGithubCommit[] | undefined;
  if (!commits || commits.length === 0) return [];

  const ref = payload.ref as string | undefined;
  const branch = ref ? ref.replace("refs/heads/", "") : null;
  const repo = raw.repo.name;

  return commits.map((c) => ({
    sha: c.sha,
    repo,
    branch,
    author: c.author.name,
    message: c.message,
    url: c.url.replace("api.github.com/repos", "github.com").replace("/commits/", "/commit/"),
    additions: null,
    deletions: null,
    changed_files: null,
    event_id: raw.id,
    committed_at: raw.created_at,
  }));
}

export class GithubPoller {
  private db: Database;
  private token: string;
  private intervalMs: number;
  private backfillPages: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private registry: ChannelRegistry | null;
  private repoConcurrency: number;
  private etags = new Map<string, string>();
  private pausedUntil = 0;

  constructor(db: Database, token: string, options: PollerOptions = {}) {
    this.db = db;
    this.token = token;
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    this.backfillPages = options.backfillPages ?? 3;
    this.registry = options.registry ?? null;
    this.repoConcurrency = Math.max(1, Math.min(options.repoConcurrency ?? 4, 8));
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge/0.1.0",
    };
  }

  private parseRateLimit(response: Response): RateLimitSnapshot | null {
    const remaining = Number(response.headers.get("X-RateLimit-Remaining") ?? NaN);
    const limit = Number(response.headers.get("X-RateLimit-Limit") ?? NaN);
    const resetSeconds = Number(response.headers.get("X-RateLimit-Reset") ?? NaN);
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !Number.isFinite(resetSeconds)) return null;
    return { remaining, limit, reset_at: new Date(resetSeconds * 1000).toISOString() };
  }

  private maybePauseForRateLimit(response: Response): boolean {
    const retryAfter = Number(response.headers.get("Retry-After") ?? NaN);
    const resetSeconds = Number(response.headers.get("X-RateLimit-Reset") ?? NaN);
    const rate = this.parseRateLimit(response);
    if ((response.status === 403 || response.status === 429) && Number.isFinite(retryAfter)) {
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfter * 1000);
      this.publishGithubSourceHealth("degraded", { status: response.status, retryAfter, pausedUntil: this.pausedUntil, ...(rate ?? {}) });
      emit(makeLogEntry("poller", "rate_limit.changed", "warn", undefined, { status: response.status, retryAfter, pausedUntil: this.pausedUntil }));
      return true;
    }
    if ((response.status === 403 || response.status === 429) && Number.isFinite(resetSeconds)) {
      this.pausedUntil = Math.max(this.pausedUntil, resetSeconds * 1000);
      const reset_at = new Date(resetSeconds * 1000).toISOString();
      this.publishGithubSourceHealth("degraded", { status: response.status, resetSeconds, pausedUntil: this.pausedUntil, reset_at, ...(rate ?? {}) });
      emit(makeLogEntry("poller", "rate_limit.changed", "warn", undefined, { status: response.status, resetSeconds, pausedUntil: this.pausedUntil }));
      return true;
    }

    if (!rate) return false;
    if (rate.remaining < 500) {
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + 60_000);
      this.publishGithubSourceHealth("degraded", { ...rate, pausedUntil: this.pausedUntil });
      emit(makeLogEntry("poller", "rate_limit.changed", "warn", undefined, { remaining: rate.remaining, limit: rate.limit, pausedUntil: this.pausedUntil }));
      return true;
    }
    if (this.pausedUntil > 0 && this.pausedUntil <= Date.now() && rate.remaining > rate.limit * 0.8) {
      this.pausedUntil = 0;
      this.publishGithubSourceHealth("fresh", rate);
    }
    return false;
  }

  private getEtagKey(repo: string, endpoint: string): string {
    return `${repo}:${endpoint}`;
  }

  private getIfNoneMatch(repo: string, endpoint: string, persistedEtag?: string | null): Record<string, string> {
    const etag = persistedEtag ?? this.etags.get(this.getEtagKey(repo, endpoint));
    return etag ? { "If-None-Match": etag } : {};
  }

  private rememberEtag(repo: string, endpoint: string, response: Response): void {
    const etag = response.headers.get("ETag");
    if (etag) this.etags.set(this.getEtagKey(repo, endpoint), etag);
  }

  /** Generic GET against GitHub REST API. Returns null on 304/error. */
  private async apiGet<T>(path: string, repo = "global", endpoint = path): Promise<T | null> {
    return (await this.apiGetWithMeta<T>(path, repo, endpoint)).data;
  }

  private async apiGetWithMeta<T>(path: string, repo = "global", endpoint = path, persistedEtag?: string | null): Promise<ApiGetResult<T>> {
    if (this.pausedUntil > Date.now()) return { data: null, status: "error", etag: persistedEtag ?? this.etags.get(this.getEtagKey(repo, endpoint)) ?? null };
    const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { ...this.headers, ...this.getIfNoneMatch(repo, endpoint, persistedEtag) } });
    } catch {
      return { data: null, status: "error", etag: persistedEtag ?? this.etags.get(this.getEtagKey(repo, endpoint)) ?? null };
    }

    const responseEtag = response.headers.get("ETag") ?? persistedEtag ?? this.etags.get(this.getEtagKey(repo, endpoint)) ?? null;
    if (response.status === 304) {
      if (responseEtag) this.etags.set(this.getEtagKey(repo, endpoint), responseEtag);
      emit(makeLogEntry("poller", "etag.hit_304", "debug", undefined, { repo, endpoint }));
      return { data: null, status: "not_modified", etag: responseEtag };
    }
    if (!response.ok) {
      this.maybePauseForRateLimit(response);
      emit(makeLogEntry("poller", "etag.miss", "debug", undefined, { repo, endpoint, status: response.status }));
      return { data: null, status: "error", etag: responseEtag };
    }
    this.maybePauseForRateLimit(response);
    this.rememberEtag(repo, endpoint, response);
    return { data: (await response.json()) as T, status: "ok", etag: responseEtag };
  }

  /** Fetch commit list + aggregate diff stats via the Compare API. */
  private async fetchCompare(
    repo: string,
    before: string,
    head: string
  ): Promise<{ commits: GithubCommit[]; additions: number; deletions: number; changed_files: number } | null> {
    interface CompareFile { additions: number; deletions: number }
    interface CompareCommit {
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      html_url: string;
    }
    interface CompareResponse {
      commits: CompareCommit[];
      files?: CompareFile[];
    }

    const data = await this.apiGet<CompareResponse>(`/repos/${repo}/compare/${before}...${head}`);
    if (!data) return null;

    const additions = data.files?.reduce((s, f) => s + f.additions, 0) ?? 0;
    const deletions = data.files?.reduce((s, f) => s + f.deletions, 0) ?? 0;
    const changed_files = data.files?.length ?? 0;

    const commits: GithubCommit[] = data.commits.map((c) => ({
      sha: c.sha,
      repo,
      branch: null,       // patched by caller
      author: c.commit.author.name,
      message: c.commit.message.split("\n")[0],
      message_full: c.commit.message,
      url: c.html_url,
      additions: null,    // per-commit stats not in compare response
      deletions: null,
      changed_files: null,
      event_id: null,     // patched by caller
      committed_at: c.commit.author.date,
    }));

    return { commits, additions, deletions, changed_files };
  }

  /** Fetch full PR details (title, body, diff stats). */
  private async fetchPullRequest(
    repo: string,
    number: number
  ): Promise<{
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    merged: boolean;
    merged_at: string | null;
    closed_at: string | null;
    user: { login: string };
    additions: number;
    deletions: number;
    changed_files: number;
    comments: number;
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
  } | null> {
    interface PRResponse {
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      merged: boolean;
      merged_at: string | null;
      closed_at: string | null;
      user: { login: string };
      additions: number;
      deletions: number;
      changed_files: number;
      comments: number;
      labels: Array<{ name: string }>;
      created_at: string;
      updated_at: string;
    }
    return this.apiGet<PRResponse>(`/repos/${repo}/pulls/${number}`);
  }

  private getRepoActiveWindow(repo: GithubRepo, state: ReturnType<typeof getRepoPollState>): number {
    const recentActivity = state.last_activity_at ? Date.now() - new Date(state.last_activity_at).getTime() : Number.POSITIVE_INFINITY;
    if (recentActivity <= 60 * 60 * 1000) return 60_000;
    if (recentActivity > 24 * 60 * 60 * 1000) return 30 * 60_000;
    return 10 * 60_000;
  }

  private publishGithubEvent(event: GithubRealtimeEvent, data: GithubPr | GithubIssue | GithubRelease | GithubEvent | SourceHealth | Record<string, unknown>, version: string): void {
    this.registry?.publish("github:activity", event, data, version);
  }

  private publishGithubSourceHealth(status: SourceHealth["status"], metadata: Record<string, unknown>): void {
    const rateLimit = rateLimitFromMetadata(metadata);
    const base = makeSourceHealth("github", status, { metadata });
    const health: GithubSourceHealth = {
      ...base,
      source: "github",
      ...(rateLimit ? { rate_limit: rateLimit } : {}),
    };
    this.publishGithubEvent("github:source_health", health, health.checked_at);
  }

  private shouldStopOnWatermark(updatedAt: string, watermark: string | null): boolean {
    return watermark !== null && updatedAt <= watermark;
  }

  private async pollIssues(repo: string, watermark: string | null, persistedEtag?: string | null): Promise<RepoEndpointPollResult> {
    interface IssueResponse {
      number: number;
      title: string;
      body: string | null;
      state: string;
      user: { login: string };
      html_url: string;
      comments: number;
      labels: Array<{ name: string }>;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
      pull_request?: object;
    }

    let latest = watermark;
    let latestEtag = persistedEtag ?? null;
    const MAX_PAGES = 20;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const endpoint = page === 1 ? "issues" : `issues:page:${page}`;
      const result = await this.apiGetWithMeta<IssueResponse[]>(`/repos/${repo}/issues?state=all&since=${encodeURIComponent(watermark ?? "1970-01-01T00:00:00Z")}&per_page=100&page=${page}`, repo, endpoint, page === 1 ? persistedEtag : undefined);
      if (page === 1) latestEtag = result.etag;
      if (result.status === "not_modified") return { watermark: latest, etag: latestEtag, successful: true };
      const items = result.data;
      if (!items) return { watermark: latest, etag: latestEtag, successful: false };
      let watermarkHit = false;
      for (const item of items) {
        if (item.pull_request) continue;
        if (this.shouldStopOnWatermark(item.updated_at, watermark)) { watermarkHit = true; break; }
        const issue: GithubIssue = {
          repo,
          number: item.number,
          title: item.title,
          body: item.body,
          state: item.state,
          author: item.user.login,
          url: item.html_url,
          comment_count: item.comments,
          label_names: item.labels.length > 0 ? JSON.stringify(item.labels.map((l) => l.name)) : null,
          created_at: item.created_at,
          updated_at: item.updated_at,
          closed_at: item.closed_at,
        };
        const existing = this.db.query<GithubIssue, { $repo: string; $number: number }>("SELECT * FROM github_issues WHERE repo = $repo AND number = $number").get({ $repo: repo, $number: item.number });
        const changed = !existing || existing.updated_at !== issue.updated_at;
        upsertIssue(this.db, issue);
        if (changed || !existing) this.publishGithubEvent("github:issue.upsert", issue, issue.updated_at ?? issue.created_at);
        latest = latest === null || item.updated_at > latest ? item.updated_at : latest;
      }
      if (watermarkHit || items.length < 100 || this.pausedUntil > Date.now()) return { watermark: latest, etag: latestEtag, successful: true };
    }
    return { watermark: latest, etag: latestEtag, successful: true };
  }

  private async pollPullRequests(repo: string, watermark: string | null, persistedEtag?: string | null): Promise<RepoEndpointPollResult> {
    interface PullsResponse {
      number: number;
      title: string;
      body: string | null;
      state: string;
      merged_at: string | null;
      closed_at: string | null;
      user: { login: string };
      html_url: string;
      comments: number;
      labels: Array<{ name: string }>;
      created_at: string;
      updated_at: string;
    }

    let latest = watermark;
    let latestEtag = persistedEtag ?? null;
    const MAX_PAGES = 20;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const endpoint = page === 1 ? "pulls" : `pulls:page:${page}`;
      const result = await this.apiGetWithMeta<PullsResponse[]>(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`, repo, endpoint, page === 1 ? persistedEtag : undefined);
      if (page === 1) latestEtag = result.etag;
      if (result.status === "not_modified") return { watermark: latest, etag: latestEtag, successful: true };
      const prs = result.data;
      if (!prs) return { watermark: latest, etag: latestEtag, successful: false };
      let watermarkHit = false;
      for (const pr of prs) {
        if (this.shouldStopOnWatermark(pr.updated_at, watermark)) { watermarkHit = true; break; }
        const record: GithubPr = {
          repo,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.merged_at !== null && pr.state === "closed" ? "merged" : pr.state,
          author: pr.user.login,
          url: pr.html_url,
          additions: null,
          deletions: null,
          changed_files: null,
          comment_count: pr.comments,
          label_names: pr.labels.length > 0 ? JSON.stringify(pr.labels.map((l) => l.name)) : null,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          merged_at: pr.merged_at,
          closed_at: pr.closed_at,
        };
        const existing = this.db.query<GithubPr, { $repo: string; $number: number }>("SELECT * FROM github_prs WHERE repo = $repo AND number = $number").get({ $repo: repo, $number: pr.number });
        const changed = !existing || existing.updated_at !== record.updated_at;
        upsertPr(this.db, record);
        if (changed || !existing) this.publishGithubEvent("github:pr.upsert", record, record.updated_at ?? record.created_at);
        latest = latest === null || pr.updated_at > latest ? pr.updated_at : latest;
      }
      if (watermarkHit || prs.length < 100 || this.pausedUntil > Date.now()) return { watermark: latest, etag: latestEtag, successful: true };
    }
    return { watermark: latest, etag: latestEtag, successful: true };
  }

  private async pollReleases(repo: string, watermark: string | null, persistedEtag?: string | null): Promise<RepoEndpointPollResult> {
    interface ReleasesResponse {
      id: number;
      tag_name: string;
      name: string | null;
      body: string | null;
      html_url: string;
      author: { login: string } | null;
      published_at: string | null;
      created_at: string;
      draft: boolean;
      prerelease: boolean;
    }

    // forge-nwdr: poll /repos/<x>/releases per cycle. Mirrors pollPullRequests
    // structure: ETag-gated, sort=created desc (the API's default), paginate
    // until watermark hit or short page. Watermark is on published_at because
    // that's the user-meaningful "when did the release happen" timestamp;
    // unpublished drafts have null published_at and are skipped.
    let latest = watermark;
    let latestEtag = persistedEtag ?? null;
    const MAX_PAGES = 5; // releases are far rarer than PRs; 5 pages * 100 = 500
    for (let page = 1; page <= MAX_PAGES; page++) {
      const endpoint = page === 1 ? "releases" : `releases:page:${page}`;
      const result = await this.apiGetWithMeta<ReleasesResponse[]>(`/repos/${repo}/releases?per_page=100&page=${page}`, repo, endpoint, page === 1 ? persistedEtag : undefined);
      if (page === 1) latestEtag = result.etag;
      if (result.status === "not_modified") return { watermark: latest, etag: latestEtag, successful: true };
      const releases = result.data;
      if (!releases) return { watermark: latest, etag: latestEtag, successful: false };
      let watermarkHit = false;
      for (const release of releases) {
        const publishedAt = release.published_at;
        if (publishedAt === null) continue; // skip drafts
        if (this.shouldStopOnWatermark(publishedAt, watermark)) { watermarkHit = true; break; }
        const record: GithubRelease = {
          id: String(release.id),
          tag_name: release.tag_name,
          name: release.name,
          body: release.body,
          html_url: release.html_url,
          author_login: release.author?.login ?? "",
          published_at: publishedAt,
          repo_full_name: repo,
        };
        const existing = this.db.query<{ release_id: string; published_at: string }, { $repo: string; $tag: string }>(
          "SELECT release_id, published_at FROM github_releases WHERE repo = $repo AND tag_name = $tag",
        ).get({ $repo: repo, $tag: release.tag_name });
        const changed = !existing || existing.published_at !== publishedAt || existing.release_id !== record.id;
        upsertRelease(this.db, record);
        if (changed || !existing) this.publishGithubEvent("github:release.upsert", record, publishedAt);
        latest = latest === null || publishedAt > latest ? publishedAt : latest;
      }
      if (watermarkHit || releases.length < 100 || this.pausedUntil > Date.now()) return { watermark: latest, etag: latestEtag, successful: true };
    }
    return { watermark: latest, etag: latestEtag, successful: true };
  }

  private isRepoDue(repo: GithubRepo, state: ReturnType<typeof getRepoPollState>, now = Date.now()): boolean {
    if (state.paused_until && new Date(state.paused_until).getTime() > now) return false;
    if (!repo.last_polled_at) return true;
    const lastPolledAt = new Date(repo.last_polled_at).getTime();
    if (!Number.isFinite(lastPolledAt)) return true;
    return now - lastPolledAt >= this.getRepoActiveWindow(repo, state);
  }

  private latestActivityAt(...values: Array<string | null>): string | null {
    return values.filter((value): value is string => value !== null).sort().at(-1) ?? null;
  }

  private markRepoPolled(repo: string, polledAt: string): void {
    this.db.prepare("UPDATE github_repos SET last_polled_at = $last_polled_at WHERE full_name = $repo").run({ $repo: repo, $last_polled_at: polledAt });
  }

  private async pollRepo(repo: GithubRepo): Promise<void> {
    const state = getRepoPollState(this.db, repo.full_name);
    if (!this.isRepoDue(repo, state)) return;

    const issueResult = await this.pollIssues(repo.full_name, state.last_issue_updated_at, state.issue_etag);
    const prResult = await this.pollPullRequests(repo.full_name, state.last_pr_updated_at, state.pr_etag);
    const releaseResult = await this.pollReleases(repo.full_name, state.last_release_published_at, state.release_etag);
    const lastIssueUpdatedAt = issueResult.watermark ?? state.last_issue_updated_at;
    const lastPrUpdatedAt = prResult.watermark ?? state.last_pr_updated_at;
    const lastReleasePublishedAt = releaseResult.watermark ?? state.last_release_published_at;
    const polledAt = new Date().toISOString();
    upsertRepoPollState(this.db, {
      repo: repo.full_name,
      last_issue_updated_at: lastIssueUpdatedAt,
      last_pr_updated_at: lastPrUpdatedAt,
      last_activity_at: this.latestActivityAt(lastIssueUpdatedAt, lastPrUpdatedAt, lastReleasePublishedAt, state.last_activity_at),
      issue_etag: issueResult.etag ?? state.issue_etag,
      pr_etag: prResult.etag ?? state.pr_etag,
      paused_until: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null,
      last_release_published_at: lastReleasePublishedAt,
      release_etag: releaseResult.etag ?? state.release_etag,
    });
    if (issueResult.successful && prResult.successful && releaseResult.successful) {
      this.markRepoPolled(repo.full_name, polledAt);
    }
  }

  async pollRepos(): Promise<void> {
    const now = Date.now();
    const repos = getRepos(this.db).filter((repo) => repo.tracked && this.isRepoDue(repo, getRepoPollState(this.db, repo.full_name), now));
    let index = 0;
    const workers = Array.from({ length: Math.min(this.repoConcurrency, repos.length) }, async () => {
      while (index < repos.length && this.pausedUntil <= Date.now()) {
        const repo = repos[index++];
        if (repo) await this.pollRepo(repo);
      }
    });
    await Promise.all(workers);
  }

  async backfillPrsAndIssues(repos: string[]): Promise<void> {
    for (const repo of repos) {
      await this.pollIssues(repo, null);
      await this.pollPullRequests(repo, null);
    }
  }

  // ---------------------------------------------------------------------------
  // Core ingestion
  // ---------------------------------------------------------------------------

  async ingestEvents(rawEvents: RawGithubEvent[]): Promise<void> {
    let newEvents = 0;
    let newCommits = 0;

    for (const raw of rawEvents) {
      const event = transformEvent(raw);
      ensureRepo(this.db, event.repo);
      const isNew = insertEvent(this.db, event);
      let eventToPublish = event;
      if (isNew) newEvents++;

      if (raw.type === "PushEvent") {
        const payload = raw.payload as {
          ref?: string;
          head?: string;
          before?: string;
          size?: number;
          commits?: RawGithubCommit[];
        };
        const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : null;
        const head = payload.head;
        const before = payload.before;
        const isInitialCommit = before === "0000000000000000000000000000000000000000";

        if (isNew && head && before && !isInitialCommit) {
          // Enrich via Compare API: full commit list + aggregate diff stats
          const compareData = await this.fetchCompare(raw.repo.name, before, head);
          if (compareData) {
            const title = compareData.commits.at(-1)?.message ?? null;
            updateEventEnrichment(this.db, raw.id, {
              commit_count: compareData.commits.length,
              additions: compareData.additions,
              deletions: compareData.deletions,
              changed_files: compareData.changed_files,
              title,
            });
            eventToPublish = {
              ...eventToPublish,
              commit_count: compareData.commits.length,
              additions: compareData.additions,
              deletions: compareData.deletions,
              changed_files: compareData.changed_files,
              title,
            };
            for (const commit of compareData.commits) {
              commit.branch = branch;
              commit.event_id = raw.id;
              if (insertCommit(this.db, commit)) newCommits++;
            }
          } else {
            // Compare API unavailable (private repo without contents scope, etc.)
            // Fall back to payload commits if present
            const commits = transformCommits(raw);
            for (const commit of commits) {
              if (insertCommit(this.db, commit)) newCommits++;
            }
          }
        } else if (!isNew) {
          // Event already stored; still try payload commits in case they were missed
          const commits = transformCommits(raw);
          for (const commit of commits) {
            if (insertCommit(this.db, commit)) newCommits++;
          }
        }
      } else if (raw.type === "PullRequestEvent" && isNew) {
        const pr = raw.payload.pull_request as { number?: number } | undefined;
        const prNumber = pr?.number;
        if (prNumber) {
          const prData = await this.fetchPullRequest(raw.repo.name, prNumber);
          if (prData) {
            updateEventEnrichment(this.db, raw.id, {
              title: prData.title,
              body: prData.body,
              url: prData.html_url,
              additions: prData.additions,
              deletions: prData.deletions,
              changed_files: prData.changed_files,
            });
            eventToPublish = {
              ...eventToPublish,
              title: prData.title,
              body: prData.body,
              url: prData.html_url,
              additions: prData.additions,
              deletions: prData.deletions,
              changed_files: prData.changed_files,
            };
            const labels = prData.labels ?? [];
            const labelNames = labels.length > 0
              ? JSON.stringify(labels.map((l) => l.name))
              : null;
            const state = prData.merged && prData.state === "closed" ? "merged" : prData.state;
            upsertPr(this.db, {
              repo: raw.repo.name,
              number: prNumber,
              title: prData.title,
              body: prData.body,
              state,
              author: prData.user?.login ?? "unknown",
              url: prData.html_url,
              additions: prData.additions,
              deletions: prData.deletions,
              changed_files: prData.changed_files,
              comment_count: prData.comments ?? 0,
              label_names: labelNames,
              created_at: prData.created_at,
              updated_at: prData.updated_at,
              merged_at: prData.merged_at ?? null,
              closed_at: prData.closed_at ?? null,
            });
          }
        }
      }

      if (isNew) {
        this.publishGithubEvent("github:event.append", eventToPublish, eventToPublish.created_at);
      }
    }

    if (newEvents > 0 || newCommits > 0) {
      console.log(`[github-poller] ingested ${newEvents} new events, ${newCommits} new commits`);
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async pollUser(username: string): Promise<void> {
    const url = `https://api.github.com/users/${username}/events?per_page=100`;
    let response: Response;
    try {
      response = await fetch(url, { headers: this.headers });
    } catch (err) {
      throw new Error(`[github-poller] Network error polling ${username}: ${err}`);
    }

    if (!response.ok) {
      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (remaining && parseInt(remaining) < 50) {
        console.warn(`[github-poller] Rate limit low: ${remaining} requests remaining`);
      }
      throw new Error(`GitHub API error ${response.status} for /users/${username}/events`);
    }

    const remaining = response.headers.get("X-RateLimit-Remaining");
    const limit = response.headers.get("X-RateLimit-Limit");
    if (remaining && limit) {
      const ratio = parseInt(remaining) / parseInt(limit);
      if (ratio < 0.1) {
        console.warn(`[github-poller] Rate limit at ${Math.round(ratio * 100)}% — backing off`);
        await Bun.sleep(60_000);
      }
    }

    const events: RawGithubEvent[] = await response.json();
    await this.ingestEvents(events);
  }

  async backfill(username: string): Promise<void> {
    console.log(`[github-poller] Backfilling user events for ${username} (up to ${this.backfillPages} pages)`);
    const startedAt = Date.now();
    emit(makeLogEntry("poller", "cycle.start", "info", undefined, { username, phase: "backfill" }));

    for (let page = 1; page <= this.backfillPages; page++) {
      const url = `https://api.github.com/users/${username}/events?per_page=100&page=${page}`;
      let response: Response;
      try {
        response = await fetch(url, { headers: this.headers });
      } catch {
        console.warn(`[github-poller] Backfill page ${page} network error`);
        break;
      }
      if (!response.ok) {
        console.warn(`[github-poller] Backfill page ${page} failed: ${response.status}`);
        break;
      }
      const events: RawGithubEvent[] = await response.json();
      if (events.length === 0) break;

      console.log(`[github-poller] Page ${page}: ${events.length} events`);
      await this.ingestEvents(events);
    }

    // After events are ingested, repos are known — backfill PRs and issues
    const repos = getRepos(this.db);
    if (repos.length > 0) {
      await this.backfillPrsAndIssues(repos.map((r) => r.full_name));
    }
    emit(makeLogEntry("poller", "cycle.complete", "info", undefined, { username, phase: "backfill", repos: repos.length, durationMs: Date.now() - startedAt }));
  }

  start(username: string): void {
    if (this.timer) return;
    console.log(`[github-poller] Starting poll loop for ${username}, interval=${this.intervalMs}ms`);
    this.timer = setInterval(async () => {
      const startedAt = Date.now();
      emit(makeLogEntry("poller", "cycle.start", "info", undefined, { username, phase: "poll" }));
      try {
        await this.pollUser(username);
        await this.pollRepos();
        emit(makeLogEntry("poller", "cycle.complete", "info", undefined, { username, phase: "poll", durationMs: Date.now() - startedAt }));
      } catch (err) {
        console.error(`[github-poller] Error polling GitHub:`, err);
        emit(makeLogEntry("poller", "error", "error", "poll loop failed", { error: (err as Error).message }));
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[github-poller] Stopped.");
    }
  }
}

function rateLimitFromMetadata(metadata: Record<string, unknown>): GithubSourceHealth["rate_limit"] | undefined {
  const remaining = Number(metadata.remaining);
  const limit = Number(metadata.limit);
  const resetAt = typeof metadata.reset_at === "string" ? metadata.reset_at : undefined;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || !resetAt) return undefined;
  return { remaining, limit, reset_at: resetAt };
}

// Entry point for direct execution: bun run src/core/github-poller.ts
if (import.meta.main) {
  const token = getGithubToken();
  const dataDir = process.env.GITBOARD_DATA_DIR ?? `${process.env.HOME}/.agent-forge`;
  const dbPath = join(dataDir, "gitboard.sqlite");

  // Import at runtime to avoid circular issues when running as script
  const { createDatabase } = await import("./store.ts");

  const db = createDatabase(dbPath);
  const username = await getAuthenticatedUsername(token);

  const poller = new GithubPoller(db, token, { intervalMs: 5 * 60 * 1000 });

  console.log(`[github-poller] Running backfill for user ${username}...`);
  await poller.backfill(username);

  poller.start(username);
  console.log("[github-poller] Poll loop running. Ctrl+C to stop.");

  process.on("SIGINT", () => {
    poller.stop();
    db.close();
    process.exit(0);
  });
}
