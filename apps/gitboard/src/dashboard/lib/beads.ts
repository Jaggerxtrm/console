// Beads API client (retired /beadboard bridge removed).

import type {
  BeadIssue,
  BeadIssueDetail,
  BeadsProject,
  BeadsStats,
  BeadsConnectionStatus,
  Memory,
  Interaction,
} from "../../types/beads.ts";

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

const API_BASE = import.meta.env.VITE_SUBSTRATE_API_URL || import.meta.env.VITE_BEADS_API_URL || "";

async function jsonFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`beads-api ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

export const substrateApi = {
  async listProjects(): Promise<BeadsProject[]> {
    const data = await jsonFetch<{ projects?: BeadsProject[] }>("/api/substrate/projects");
    return data.projects ?? [];
  },

  async listIssues(projectId: string, filters?: { status?: BeadIssue["status"][]; priority?: BeadIssue["priority"][]; search?: string; limit?: number }): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status.join(","));
    if (filters?.priority) params.set("priority", filters.priority.map(String).join(","));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    const data = await jsonFetch<{ issues?: BeadIssue[] }>(`/api/substrate/projects/${enc(projectId)}/issues${qs ? `?${qs}` : ""}`);
    return data.issues ?? [];
  },

  async getIssue(projectId: string, issueId: string): Promise<BeadIssueDetail | null> {
    try {
      const data = await jsonFetch<{ issue?: BeadIssueDetail }>(`/api/substrate/projects/${enc(projectId)}/issues/${enc(issueId)}`);
      return data.issue ?? null;
    } catch {
      return null;
    }
  },

  async listClosedIssues(projectId: string, limit?: number): Promise<BeadIssue[]> {
    const qs = limit ? `?limit=${limit}` : "";
    const data = await jsonFetch<{ issues?: BeadIssue[] }>(`/api/substrate/projects/${enc(projectId)}/issues/closed${qs}`);
    return data.issues ?? [];
  },

  async listMemories(projectId: string): Promise<Memory[]> {
    const data = await jsonFetch<{ memories?: Memory[] }>(`/api/substrate/projects/${enc(projectId)}/memories`);
    return data.memories ?? [];
  },

  async listInteractions(projectId: string, issueId?: string): Promise<Interaction[]> {
    const qs = issueId ? `?issue_id=${enc(issueId)}` : "";
    const data = await jsonFetch<{ interactions?: Interaction[] }>(`/api/substrate/projects/${enc(projectId)}/interactions${qs}`);
    return data.interactions ?? [];
  },

  async getStats(projectId: string): Promise<BeadsStats> {
    const data = await jsonFetch<{ stats: BeadsStats }>(`/api/substrate/projects/${enc(projectId)}/stats`);
    return data.stats;
  },

  async getConnection(projectId: string): Promise<BeadsConnectionStatus> {
    return await jsonFetch<BeadsConnectionStatus>(`/api/substrate/projects/${enc(projectId)}/connection`);
  },
};
