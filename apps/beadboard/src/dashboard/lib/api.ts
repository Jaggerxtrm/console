/**
 * API client for beadboard frontend
 */

import type { BeadIssue, BeadIssueDetail, BeadsProject, Memory, Interaction } from "../types/beads.ts";

const API_BASE = "";

export const api = {
  async getProjects(): Promise<BeadsProject[]> {
    const res = await fetch(`${API_BASE}/api/beads/projects`);
    const data: any = await res.json();
    return data.projects || [];
  },

  async getIssues(projectId: string, filters?: { status?: BeadIssue["status"][]; priority?: BeadIssue["priority"][]; search?: string; limit?: number }): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status.join(","));
    if (filters?.priority) params.set("priority", filters.priority.join(","));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.limit) params.set("limit", filters.limit.toString());

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/issues?${params}`);
    const data: any = await res.json();
    return data.issues || [];
  },

  async getIssue(projectId: string, issueId: string): Promise<BeadIssueDetail | null> {
    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/issues/${issueId}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.issue || null;
  },

  async getClosedIssues(projectId: string, limit?: number): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", limit.toString());

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/issues/closed?${params}`);
    const data: any = await res.json();
    return data.issues || [];
  },

  async getMemories(projectId: string): Promise<Memory[]> {
    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/memories`);
    const data: any = await res.json();
    return data.memories || [];
  },

  async getInteractions(projectId: string, issueId?: string): Promise<Interaction[]> {
    const params = new URLSearchParams();
    if (issueId) params.set("issue_id", issueId);

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/interactions?${params}`);
    const data: any = await res.json();
    return data.interactions || [];
  },

  async getStats(projectId: string): Promise<{ total: number; open: number; in_progress: number; blocked: number; closed: number; by_priority: Record<string, number>; by_type: Record<string, number> }> {
    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/stats`);
    const data: any = await res.json();
    return data.stats;
  },

  async getOpenPrs(limit = 300): Promise<OpenPr[]> {
    const res = await fetch(`${API_BASE}/api/github/prs?state=open&limit=${limit}`);
    const data: any = await res.json();
    return data.data || [];
  },
};

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
