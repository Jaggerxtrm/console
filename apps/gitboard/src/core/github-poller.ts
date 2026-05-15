import type { Database } from "bun:sqlite";
import {
  insertEvent,
  insertCommit,
  ensureRepo,
  updateEventEnrichment,
  upsertPr,
  upsertIssue,
  getRepos,
} from "./github-store.ts";
import type { GithubEvent, GithubCommit } from "./github-store.ts";

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

  constructor(db: Database, token: string, options: PollerOptions = {}) {
    this.db = db;
    this.token = token;
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    this.backfillPages = options.backfillPages ?? 3;
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

  /** Generic GET against the GitHub REST API. Returns null on error. */
  private async apiGet<T>(path: string): Promise<T | null> {
    const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: this.headers });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const limit = response.headers.get("X-RateLimit-Limit");
    if (remaining && limit) {
      const ratio = parseInt(remaining) / parseInt(limit);
      if (ratio < 0.1) {
        console.warn(`[github-poller] Rate limit at ${Math.round(ratio * 100)}% — backing off`);
        await Bun.sleep(60_000);
      }
    }
    return (await response.json()) as T;
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

  private async fetchAndUpsertIssues(repo: string): Promise<void> {
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

    let page = 1;
    while (true) {
      const items = await this.apiGet<IssueResponse[]>(
        `/repos/${repo}/issues?state=all&per_page=100&page=${page}`
      );
      if (!items || items.length === 0) break;

      for (const item of items) {
        if (item.pull_request) continue;

        const labelNames = item.labels.length > 0
          ? JSON.stringify(item.labels.map((l) => l.name))
          : null;

        upsertIssue(this.db, {
          repo,
          number: item.number,
          title: item.title,
          body: item.body,
          state: item.state,
          author: item.user.login,
          url: item.html_url,
          comment_count: item.comments,
          label_names: labelNames,
          created_at: item.created_at,
          updated_at: item.updated_at,
          closed_at: item.closed_at,
        });
      }

      if (items.length < 100) break;
      page++;
    }
  }

  async backfillPrsAndIssues(repos: string[]): Promise<void> {
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

    for (const repo of repos) {
      console.log(`[github-poller] Backfilling PRs for ${repo}`);
      let page = 1;
      while (true) {
        const prs = await this.apiGet<PullsResponse[]>(
          `/repos/${repo}/pulls?state=all&per_page=100&page=${page}`
        );
        if (!prs || prs.length === 0) break;

        for (const pr of prs) {
          const labelNames = pr.labels.length > 0
            ? JSON.stringify(pr.labels.map((l) => l.name))
            : null;
          const state = pr.merged_at !== null && pr.state === "closed" ? "merged" : pr.state;
          upsertPr(this.db, {
            repo,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state,
            author: pr.user.login,
            url: pr.html_url,
            additions: null,
            deletions: null,
            changed_files: null,
            comment_count: pr.comments,
            label_names: labelNames,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            merged_at: pr.merged_at,
            closed_at: pr.closed_at,
          });
        }

        if (prs.length < 100) break;
        page++;
      }

      console.log(`[github-poller] Backfilling issues for ${repo}`);
      try {
        await this.fetchAndUpsertIssues(repo);
      } catch (err) {
        console.warn(`[github-poller] Issue backfill failed for ${repo}:`, err);
      }
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
            updateEventEnrichment(this.db, raw.id, {
              commit_count: compareData.commits.length,
              additions: compareData.additions,
              deletions: compareData.deletions,
              changed_files: compareData.changed_files,
              // Use the last commit message as the push title (most recent)
              title: compareData.commits.at(-1)?.message ?? null,
            });
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
  }

  start(username: string): void {
    if (this.timer) return;
    console.log(`[github-poller] Starting poll loop for ${username}, interval=${this.intervalMs}ms`);
    this.timer = setInterval(async () => {
      try {
        await this.pollUser(username);
      } catch (err) {
        console.error(`[github-poller] Error polling user events:`, err);
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

// Entry point for direct execution: bun run src/core/github-poller.ts
if (import.meta.main) {
  const token = getGithubToken();
  const dbPath = process.env.AGENT_FORGE_DB ?? `${process.env.HOME}/.agent-forge/state.db`;

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
