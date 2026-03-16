/**
 * API client for beadboard frontend
 */

import type { BeadIssue, BeadsProject, Memory, Interaction } from "../types/beads.ts";

// Use relative URLs so we hit the same server that serves the frontend
const API_BASE = "";

export const api = {
  // Projects
  async getProjects(): Promise<BeadsProject[]> {
    const res = await fetch(`${API_BASE}/api/beads/projects`);
    const data = await res.json();
    return data.projects || [];
  },

  // Issues
  async getIssues(projectId: string, filters?: {
    status?: BeadIssue["status"][];
    priority?: BeadIssue["priority"][];
    search?: string;
    limit?: number;
  }): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status.join(","));
    if (filters?.priority) params.set("priority", filters.priority.join(","));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.limit) params.set("limit", filters.limit.toString());

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/issues?${params}`);
    const data = await res.json();
    return data.issues || [];
  },

  async getClosedIssues(projectId: string, limit?: number): Promise<BeadIssue[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", limit.toString());

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/issues/closed?${params}`);
    const data = await res.json();
    return data.issues || [];
  },

  // Memories
  async getMemories(projectId: string): Promise<Memory[]> {
    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/memories`);
    const data = await res.json();
    return data.memories || [];
  },

  // Interactions
  async getInteractions(projectId: string, issueId?: string): Promise<Interaction[]> {
    const params = new URLSearchParams();
    if (issueId) params.set("issue_id", issueId);

    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/interactions?${params}`);
    const data = await res.json();
    return data.interactions || [];
  },

  // Stats
  async getStats(projectId: string): Promise<{
    total: number;
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
    by_priority: Record<string, number>;
    by_type: Record<string, number>;
  }> {
    const res = await fetch(`${API_BASE}/api/beads/projects/${projectId}/stats`);
    const data = await res.json();
    return data.stats;
  },
};