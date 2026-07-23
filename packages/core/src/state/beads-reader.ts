/**
 * Beads Reader - Reads issues and data from beads databases
 */

import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { BeadIssue, BeadDependency, Memory, Interaction, IssueFilters } from "../types/beads.ts";

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

export class BeadsReader {
  constructor(private db: Database) {}

  /**
   * Get issues with optional filters
   */
  async getIssues(filters: IssueFilters): Promise<BeadIssue[]> {
    const conditions: string[] = [];
    const params: Record<string, string | number | bigint | Uint8Array | null> = {};

    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map((_, i) => `$status${i}`).join(", ");
      conditions.push(`status IN (${placeholders})`);
      filters.status.forEach((s, i) => (params[`$status${i}`] = s));
    }

    if (filters.priority && filters.priority.length > 0) {
      const placeholders = filters.priority.map((_, i) => `$priority${i}`).join(", ");
      conditions.push(`priority IN (${placeholders})`);
      filters.priority.forEach((p, i) => (params[`$priority${i}`] = p));
    }

    if (filters.issue_type && filters.issue_type.length > 0) {
      const placeholders = filters.issue_type.map((_, i) => `$type${i}`).join(", ");
      conditions.push(`issue_type IN (${placeholders})`);
      filters.issue_type.forEach((t, i) => (params[`$type${i}`] = t));
    }

    if (filters.search) {
      conditions.push("(title LIKE $search OR description LIKE $search)");
      params.$search = `%${filters.search}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.$limit = filters.limit ?? 100;
    params.$offset = filters.offset ?? 0;

    const issues = this.db
      .query<{
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: number;
        issue_type: string;
        owner: string | null;
        created_at: string;
        created_by: string | null;
        updated_at: string | null;
        closed_at: string | null;
        close_reason: string | null;
      }, Record<string, string | number | bigint | Uint8Array | null>>(
        `SELECT * FROM issues ${where} ORDER BY priority ASC, created_at DESC LIMIT $limit OFFSET $offset`
      )
      .all(params);

    // Fetch dependencies and labels for each issue
    const result: BeadIssue[] = [];
    for (const issue of issues) {
      const dependencies = this.getDependencies(issue.id);
      const labels = this.getLabels(issue.id);

      result.push({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        status: issue.status as BeadIssue["status"],
        priority: issue.priority as BeadIssue["priority"],
        issue_type: issue.issue_type as BeadIssue["issue_type"],
        owner: issue.owner,
        created_at: issue.created_at,
        created_by: issue.created_by,
        updated_at: issue.updated_at ?? issue.created_at,
        closed_at: issue.closed_at ?? undefined,
        close_reason: issue.close_reason ?? undefined,
        project_id: "", // Set by caller
        dependencies,
        labels,
        related_ids: [],
      });
    }

    return result;
  }

  /**
   * Get dependencies for an issue
   */
  private getDependencies(issueId: string): BeadDependency[] {
    const deps = this.db
      .query<{
        to_issue: string;
        dependency_type: string;
        title: string;
        status: string;
      }, { $id: string }>(
        `SELECT d.to_issue, d.dependency_type, i.title, i.status
         FROM dependencies d
         JOIN issues i ON d.to_issue = i.id
         WHERE d.from_issue = $id`
      )
      .all({ $id: issueId });

    return deps.map((d) => ({
      id: d.to_issue,
      title: d.title,
      status: d.status as BeadDependency["status"],
      dependency_type: d.dependency_type as BeadDependency["dependency_type"],
    }));
  }

  /**
   * Get labels for an issue
   */
  private getLabels(issueId: string): string[] {
    const labels = this.db
      .query<{ label: string }, { $id: string }>(
        "SELECT label FROM issue_labels WHERE issue_id = $id"
      )
      .all({ $id: issueId });

    return labels.map((l) => l.label);
  }

  /**
   * Get closed issues ordered by closed_at DESC
   */
  async getClosedIssues(limit: number = 50): Promise<BeadIssue[]> {
    const issues = this.db
      .query<{
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: number;
        issue_type: string;
        owner: string | null;
        created_at: string;
        created_by: string | null;
        updated_at: string | null;
        closed_at: string | null;
        close_reason: string | null;
      }, { $limit: number }>(
        `SELECT * FROM issues
         WHERE status = 'closed' AND closed_at IS NOT NULL
         ORDER BY closed_at DESC
         LIMIT $limit`
      )
      .all({ $limit: limit });

    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      description: issue.description,
      status: "closed" as const,
      priority: issue.priority as BeadIssue["priority"],
      issue_type: issue.issue_type as BeadIssue["issue_type"],
      owner: issue.owner,
      created_at: issue.created_at,
      created_by: issue.created_by,
      updated_at: issue.updated_at ?? issue.created_at,
      closed_at: issue.closed_at ?? undefined,
      close_reason: issue.close_reason ?? undefined,
      project_id: "",
      dependencies: [],
      labels: [],
      related_ids: [],
    }));
  }

  /**
   * Read memories from knowledge.jsonl
   */
  async getMemories(knowledgePath: string): Promise<Memory[]> {
    try {
      const content = await readFile(knowledgePath, "utf-8");
      const lines = content.trim().split("\n");

      return lines
        .filter((line) => line.trim())
        .map((line) => {
          const data = JSON.parse(line);
          return {
            id: data.id,
            content: data.content,
            type: data.type || "learned",
            tags: data.tags || [],
            created_at: data.created_at,
            issue_id: data.issue_id,
            project_id: "", // Set by caller
          } as Memory;
        });
    } catch {
      return [];
    }
  }

  /**
   * Parse interactions.jsonl for agent sessions
   */
  async getInteractions(interactionsPath: string): Promise<Interaction[]> {
    try {
      const content = await readFile(interactionsPath, "utf-8");
      const lines = content.trim().split("\n");

      return lines
        .filter((line) => line.trim())
        .map((line) => {
          const data = JSON.parse(line);
          return {
            id: data.id,
            kind: data.kind || "tool_call",
            created_at: data.created_at,
            actor: data.actor,
            issue_id: data.issue_id,
            model: data.model,
            tool_name: data.tool_name,
            exit_code: data.exit_code,
            project_id: "", // Set by caller
          } as Interaction;
        });
    } catch {
      return [];
    }
  }

  /**
   * Infer agent from model string
   */
  static inferAgent(model?: string): "claude" | "pi" | "qwen" | "gemini" | "other" {
    if (!model) return "other";
    const lower = model.toLowerCase();
    if (lower.includes("claude")) return "claude";
    if (lower.includes("qwen")) return "qwen";
    if (lower.includes("gemini")) return "gemini";
    if (lower.includes("gpt")) return "other";
    return "other";
  }

  static parseIssueLine(line: string): BeadIssue[] {
    const data = parseJsonLine(line);
    if (!data || data._type === "memory" || data._type === "kv") return [];
    const id = stringOrUndefined(data.id);
    if (!id) return [];
    const dependencies = Array.isArray(data.dependencies)
      ? data.dependencies.flatMap((dep): BeadDependency[] => {
        if (!dep || typeof dep !== "object") return [];
        const row = dep as Record<string, unknown>;
        const depId = stringOrUndefined(row.id ?? row.to_issue ?? row.depends_on_issue_id ?? row.depends_on_id);
        if (!depId) return [];
        return [{
          id: depId,
          title: String(row.title ?? ""),
          status: String(row.status ?? "open") as BeadDependency["status"],
          dependency_type: String(row.dependency_type ?? row.type ?? "blocks") as BeadDependency["dependency_type"],
        }];
      })
      : [];
    return [{
      id,
      title: String(data.title ?? id),
      description: stringOrNull(data.description),
      notes: stringOrNull(data.notes),
      status: String(data.status ?? "open") as BeadIssue["status"],
      priority: typeof data.priority === "number" ? data.priority as BeadIssue["priority"] : 2,
      issue_type: String(data.issue_type ?? data.type ?? "task") as BeadIssue["issue_type"],
      owner: stringOrNull(data.owner),
      assignee: stringOrUndefined(data.assignee),
      created_at: String(data.created_at ?? new Date(0).toISOString()),
      created_by: stringOrNull(data.created_by),
      updated_at: String(data.updated_at ?? data.created_at ?? new Date(0).toISOString()),
      closed_at: stringOrUndefined(data.closed_at),
      close_reason: stringOrUndefined(data.close_reason),
      project_id: String(data.project_id ?? ""),
      dependencies,
      parent_id: stringOrUndefined(data.parent_id),
      related_ids: Array.isArray(data.related_ids) ? data.related_ids.map(String) : [],
      labels: Array.isArray(data.labels) ? data.labels.map(String) : [],
      metadata: data.metadata,
      formula_name: stringOrUndefined(data.formula_name),
      template_name: stringOrUndefined(data.template_name),
    }];
  }

  static parseMemoryLine(line: string): Memory[] {
    const data = parseJsonLine(line);
    if (!data) return [];
    const id = stringOrUndefined(data.id);
    if (!id) return [];
    return [{
      id,
      content: String(data.content ?? ""),
      type: String(data.type ?? "learned") as Memory["type"],
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      created_at: String(data.created_at ?? new Date(0).toISOString()),
      issue_id: stringOrUndefined(data.issue_id),
      project_id: String(data.project_id ?? ""),
    }];
  }
}
