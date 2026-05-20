// Beads API client (forge-5w9.2).
// Calls gitboard's own /api/beads/* surface, which mounts beadboard routes (server.ts:6,35).
// Same-origin: no port 3010, no CORS. VITE_BEADS_API_URL override for split-host setups.

import type {
  BeadIssue,
  BeadIssueDetail,
  BeadsProject,
  BeadsStats,
  BeadsConnectionStatus,
  Memory,
  Interaction,
} from "../../types/beads.ts";

// OpenPr is the slice of /api/github/prs returned to beads UI for cross-linking
// beads to live GitHub PRs. Kept as a type-only export to avoid duplicate fetcher
// surfaces; gitboard's main github client owns the fetch.
export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string | null;
  updated_at: string | null;
  merged_at: string | null;
}

const API_BASE = import.meta.env.VITE_BEADS_API_URL || "";

async function jsonFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`beads-api ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Encode every path segment derived from remote data (project IDs, issue IDs)
// to avoid client-side path/query/fragment confusion from reserved characters
// (forge-bvq security-auditor finding).
const enc = encodeURIComponent;

export const beadsApi = {
  async listProjects(): Promise<BeadsProject[]> {
    const data = await jsonFetch<{ projects?: BeadsProject[] }>("/api/beads/projects");
    return data.projects ?? [];
  },

  async listIssues(
    projectId: string,
    filters?: { status?: BeadIssue["status"][]; priority?: BeadIssue["priority"][]; search?: string; limit?: number },
  ): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status.join(","));
    if (filters?.priority) params.set("priority", filters.priority.map(String).join(","));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    const data = await jsonFetch<{ issues?: BeadIssue[] }>(
      `/api/beads/projects/${enc(projectId)}/issues${qs ? `?${qs}` : ""}`,
    );
    return data.issues ?? [];
  },

  async getIssue(projectId: string, issueId: string): Promise<BeadIssueDetail | null> {
    try {
      const data = await jsonFetch<{ issue?: BeadIssueDetail }>(
        `/api/beads/projects/${enc(projectId)}/issues/${enc(issueId)}`,
      );
      return data.issue ?? null;
    } catch {
      return null;
    }
  },

  async listClosedIssues(projectId: string, limit?: number): Promise<BeadIssue[]> {
    const qs = limit ? `?limit=${limit}` : "";
    const data = await jsonFetch<{ issues?: BeadIssue[] }>(
      `/api/beads/projects/${enc(projectId)}/issues/closed${qs}`,
    );
    return data.issues ?? [];
  },

  async listMemories(projectId: string): Promise<Memory[]> {
    const data = await jsonFetch<{ memories?: Memory[] }>(
      `/api/beads/projects/${enc(projectId)}/memories`,
    );
    return data.memories ?? [];
  },

  async listInteractions(projectId: string, issueId?: string): Promise<Interaction[]> {
    const qs = issueId ? `?issue_id=${enc(issueId)}` : "";
    const data = await jsonFetch<{ interactions?: Interaction[] }>(
      `/api/beads/projects/${enc(projectId)}/interactions${qs}`,
    );
    return data.interactions ?? [];
  },

  async getStats(projectId: string): Promise<BeadsStats> {
    const data = await jsonFetch<{ stats: BeadsStats }>(
      `/api/beads/projects/${enc(projectId)}/stats`,
    );
    return data.stats;
  },

  async getConnection(projectId: string): Promise<BeadsConnectionStatus> {
    return await jsonFetch<BeadsConnectionStatus>(
      `/api/beads/projects/${enc(projectId)}/connection`,
    );
  },
};
