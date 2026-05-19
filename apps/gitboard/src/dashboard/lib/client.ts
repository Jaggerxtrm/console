import type {
  EventsResponse,
  CommitsResponse,
  ReposResponse,
  ContributionsResponse,
  Summary,
  GithubRepo,
  EventFilter,
  RepoStatsResponse,
  PrsResponse,
  IssuesResponse,
  GithubPrDetail,
  GithubRelease,
} from "../../types/github.ts";
import type { ObservabilitySummary, TimeRange } from "../../server/observability/metrics-dao.ts";

export class ApiClient {
  constructor(private baseUrl: string = "") {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
    return res.json() as Promise<T>;
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
    return res.json() as Promise<T>;
  }

  getEvents(filter: EventFilter = {}): Promise<EventsResponse> {
    const params = new URLSearchParams();
    if (filter.repos?.length) params.set("repos", filter.repos.join(","));
    if (filter.types?.length) params.set("types", filter.types.join(","));
    if (filter.branch) params.set("branch", filter.branch);
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
    if (filter.search) params.set("search", filter.search);
    if (filter.group) params.set("group", filter.group);
    if (filter.limit !== undefined) params.set("limit", String(filter.limit));
    if (filter.offset !== undefined) params.set("offset", String(filter.offset));
    const qs = params.toString();
    return this.get(`/api/github/events${qs ? `?${qs}` : ""}`);
  }

  getEvent(id: string): Promise<unknown> {
    return this.get(`/api/github/events/${encodeURIComponent(id)}`);
  }

  getCommits(repo?: string, from?: string, event_id?: string): Promise<CommitsResponse> {
    const params = new URLSearchParams();
    if (repo) params.set("repo", repo);
    if (from) params.set("from", from);
    if (event_id) params.set("event_id", event_id);
    const qs = params.toString();
    return this.get(`/api/github/commits${qs ? `?${qs}` : ""}`);
  }

  getRepos(): Promise<ReposResponse> {
    return this.get("/api/github/repos");
  }

  addRepo(full_name: string): Promise<GithubRepo> {
    return this.post("/api/github/repos", { full_name });
  }

  updateRepo(name: string, updates: Partial<GithubRepo>): Promise<GithubRepo> {
    return this.put(`/api/github/repos/${encodeURIComponent(name)}`, updates);
  }

  getContributions(): Promise<ContributionsResponse> {
    return this.get("/api/github/contributions");
  }

  getSummary(period: "today" | "week" | "month" = "today"): Promise<Summary> {
    return this.get(`/api/github/summary?period=${period}`);
  }

  getPrs(params: { repo?: string; state?: string; limit?: number; offset?: number } = {}): Promise<PrsResponse> {
    const q = new URLSearchParams();
    if (params.repo) q.set("repo", params.repo);
    if (params.state) q.set("state", params.state);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.get(`/api/github/prs${qs ? `?${qs}` : ""}`);
  }

  getPr(owner: string, repo: string, number: number): Promise<unknown> {
    return this.get(`/api/github/prs/${owner}/${repo}/${number}`);
  }

  getPrDetail(owner: string, repo: string, number: number): Promise<GithubPrDetail> {
    return this.get(`/api/github/prs/${owner}/${repo}/${number}/detail`);
  }

  getIssues(params: { repo?: string; state?: string; limit?: number; offset?: number } = {}): Promise<IssuesResponse> {
    const q = new URLSearchParams();
    if (params.repo) q.set("repo", params.repo);
    if (params.state) q.set("state", params.state);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.get(`/api/github/issues${qs ? `?${qs}` : ""}`);
  }

  getReleases(params: { repo?: string; limit?: number; offset?: number } = {}): Promise<{ releases: GithubRelease[] }> {
    const q = new URLSearchParams();
    if (params.repo) q.set("repo", params.repo);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.get(`/api/github/releases${qs ? `?${qs}` : ""}`);
  }

  getRepoMarkdown(owner: string, name: string, path: string): Promise<{ content: string | null; sha: string | null; last_modified: string | null }> {
    return this.get(`/api/github/repo/${owner}/${name}/markdown?path=${encodeURIComponent(path)}`);
  }

  listRepoReports(owner: string, name: string): Promise<{ data: { name: string; path: string; sha: string; size: number; frontmatter: Record<string, string> | null }[] }> {
    return this.get(`/api/github/repo/${owner}/${name}/reports`);
  }

  getRepoReport(owner: string, name: string, filename: string): Promise<{ content: string; sha: string; last_modified: string | null }> {
    return this.get(`/api/github/repo/${owner}/${name}/reports/${filename}`);
  }

  getIssue(owner: string, repo: string, number: number): Promise<unknown> {
    return this.get(`/api/github/issues/${owner}/${repo}/${number}`);
  }

  getRepoStats(): Promise<RepoStatsResponse> {
    return this.get("/api/github/repos/stats");
  }

  getObservabilitySummary(range: TimeRange): Promise<ObservabilitySummary> {
    return this.get(`/api/console/observability/summary?range=${range}`);
  }
}

export const apiClient = new ApiClient();
