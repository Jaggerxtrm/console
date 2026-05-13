/**
 * Beads Reader - Reads issues and data from beads databases
 */

import { readFile } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { BeadIssue, BeadDependency, Memory, Interaction, IssueFilters, BeadIssueDetail } from "../types/beads.ts";

export class BeadsReader {
  constructor(private db: Database) {}

  async getIssues(filters: IssueFilters): Promise<BeadIssue[]> {
    const rows = this.queryIssues(filters, false);
    return rows.map((issue) => this.toIssue(issue));
  }

  async getIssue(issueId: string): Promise<BeadIssueDetail | null> {
    const rows = this.queryIssues({ limit: 1, offset: 0, search: undefined }, true, issueId);
    const issue = rows[0];
    if (!issue) return null;

    return {
      ...this.toIssue(issue),
      dependents: this.getDependents(issueId),
      children: this.getDependents(issueId).filter((dependency) => dependency.dependency_type === "parent-child"),
      source: "sqlite",
      sourceHealth: [{ kind: "sqlite", state: "available" }],
    };
  }

  async getClosedIssues(limit: number = 50): Promise<BeadIssue[]> {
    const rows = this.queryIssues({ status: ["closed"], limit, offset: 0 }, false, undefined, true);
    return rows.map((issue) => this.toIssue(issue));
  }

  async getMemories(knowledgePath: string): Promise<Memory[]> {
    try {
      const content = await readFile(knowledgePath, "utf-8");
      return content.split("\n").flatMap((line) => BeadsReader.parseMemoryLine(line));
    } catch {
      return [];
    }
  }

  async getInteractions(interactionsPath: string): Promise<Interaction[]> {
    try {
      const content = await readFile(interactionsPath, "utf-8");
      return content.split("\n").flatMap((line) => BeadsReader.parseInteractionLine(line));
    } catch {
      return [];
    }
  }

  static parseIssueLine(line: string): BeadIssue[] {
    if (!line.trim()) return [];
    try {
      const data = JSON.parse(line) as Record<string, unknown>;
      if (data._type && data._type !== "issue") return [];
      if (typeof data.id !== "string" || typeof data.title !== "string") return [];

      const issueId = data.id;
      const dependencies = Array.isArray(data.dependencies)
        ? data.dependencies.flatMap((dependency) => BeadsReader.parseJsonlDependency(dependency, issueId))
        : [];
      const labels = Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === "string") : [];

      return [{
        id: issueId,
        title: data.title,
        description: data.description == null ? null : String(data.description),
        notes: data.notes == null ? null : String(data.notes),
        status: String(data.status ?? "open") as BeadIssue["status"],
        priority: Number(data.priority ?? 2) as BeadIssue["priority"],
        issue_type: String(data.issue_type ?? "task") as BeadIssue["issue_type"],
        owner: data.owner == null ? null : String(data.owner),
        created_at: String(data.created_at ?? ""),
        created_by: data.created_by == null ? null : String(data.created_by),
        updated_at: String(data.updated_at ?? data.created_at ?? ""),
        closed_at: data.closed_at == null ? undefined : String(data.closed_at),
        close_reason: data.close_reason == null ? undefined : String(data.close_reason),
        project_id: "",
        dependencies,
        parent_id: data.parent_id == null ? undefined : String(data.parent_id),
        related_ids: Array.isArray(data.related_ids) ? data.related_ids.filter((id): id is string => typeof id === "string") : [],
        labels,
      }];
    } catch {
      return [];
    }
  }

  private static parseJsonlDependency(value: unknown, issueId: string): BeadDependency[] {
    if (!value || typeof value !== "object") return [];
    const dependency = value as Record<string, unknown>;
    const id = dependency.depends_on_id ?? dependency.to_issue ?? dependency.id;
    if (typeof id !== "string" || id === issueId) return [];
    return [{
      id,
      title: typeof dependency.title === "string" ? dependency.title : "",
      status: String(dependency.status ?? "open") as BeadDependency["status"],
      dependency_type: String(dependency.type ?? dependency.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
    }];
  }

  static inferAgent(model?: string): "claude" | "pi" | "qwen" | "gemini" | "other" {
    if (!model) return "other";
    const lower = model.toLowerCase();
    if (lower.includes("claude")) return "claude";
    if (lower.includes("qwen")) return "qwen";
    if (lower.includes("gemini")) return "gemini";
    if (lower.includes("gpt")) return "other";
    return "other";
  }

  static parseMemoryLine(line: string): Memory[] {
    if (!line.trim()) return [];
    try {
      const data = JSON.parse(line) as Partial<Memory> & { type?: Memory["type"] };
      if (typeof data.id !== "string" || typeof data.content !== "string" || typeof data.created_at !== "string") {
        return [];
      }
      return [{
        id: data.id,
        content: data.content,
        type: data.type || "learned",
        tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string") : [],
        created_at: data.created_at,
        issue_id: typeof data.issue_id === "string" ? data.issue_id : undefined,
        project_id: "",
      }];
    } catch {
      return [];
    }
  }

  static parseInteractionLine(line: string): Interaction[] {
    if (!line.trim()) return [];
    try {
      const data = JSON.parse(line) as Partial<Interaction>;
      if (typeof data.id !== "string" || typeof data.created_at !== "string" || typeof data.actor !== "string" || typeof data.issue_id !== "string") {
        return [];
      }
      return [{
        id: data.id,
        kind: data.kind || "tool_call",
        created_at: data.created_at,
        actor: data.actor,
        issue_id: data.issue_id,
        model: typeof data.model === "string" ? data.model : undefined,
        tool_name: typeof data.tool_name === "string" ? data.tool_name : undefined,
        exit_code: typeof data.exit_code === "number" ? data.exit_code : undefined,
        project_id: "",
      }];
    } catch {
      return [];
    }
  }

  private queryIssues(
    filters: IssueFilters,
    single: boolean,
    issueId?: string,
    closedOnly = false,
  ): Array<Record<string, unknown>> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (issueId) {
      conditions.push("id = $id");
      params.$id = issueId;
    }
    if (closedOnly) conditions.push("status = 'closed'");

    if (filters.status?.length) {
      const placeholders = filters.status.map((_, i) => `$status${i}`).join(", ");
      conditions.push(`status IN (${placeholders})`);
      filters.status.forEach((value, index) => (params[`$status${index}`] = value));
    }
    if (filters.priority?.length) {
      const placeholders = filters.priority.map((_, i) => `$priority${i}`).join(", ");
      conditions.push(`priority IN (${placeholders})`);
      filters.priority.forEach((value, index) => (params[`$priority${index}`] = value));
    }
    if (filters.issue_type?.length) {
      const placeholders = filters.issue_type.map((_, i) => `$type${i}`).join(", ");
      conditions.push(`issue_type IN (${placeholders})`);
      filters.issue_type.forEach((value, index) => (params[`$type${index}`] = value));
    }
    if (filters.search) {
      conditions.push("(title LIKE $search OR description LIKE $search)");
      params.$search = `%${filters.search}%`;
    }

    params.$limit = filters.limit ?? (single ? 1 : 100);
    params.$offset = filters.offset ?? 0;

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db
      .query(`SELECT * FROM issues ${where} ORDER BY priority ASC, created_at DESC LIMIT $limit OFFSET $offset`)
      .all(params as any) as Array<Record<string, unknown>>);
  }

  private toIssue(issue: Record<string, unknown>): BeadIssue {
    const issueId = String(issue.id ?? "");
    return {
      id: issueId,
      title: String(issue.title ?? ""),
      description: issue.description == null ? null : String(issue.description),
      notes: issue.notes == null ? null : String(issue.notes),
      status: String(issue.status ?? "open") as BeadIssue["status"],
      priority: Number(issue.priority ?? 2) as BeadIssue["priority"],
      issue_type: String(issue.issue_type ?? "task") as BeadIssue["issue_type"],
      owner: issue.owner == null ? null : String(issue.owner),
      created_at: String(issue.created_at ?? ""),
      created_by: issue.created_by == null ? null : String(issue.created_by),
      updated_at: String(issue.updated_at ?? issue.created_at ?? ""),
      closed_at: issue.closed_at == null ? undefined : String(issue.closed_at),
      close_reason: issue.close_reason == null ? undefined : String(issue.close_reason),
      project_id: "",
      dependencies: this.getDependencies(issueId),
      parent_id: issue.parent_id == null ? undefined : String(issue.parent_id),
      related_ids: this.getRelatedIds(issueId),
      labels: this.getLabels(issueId),
    };
  }

  private getDependencies(issueId: string): BeadDependency[] {
    const rows = this.db
      .query(`SELECT d.to_issue, d.dependency_type, i.title, i.status FROM dependencies d JOIN issues i ON d.to_issue = i.id WHERE d.from_issue = $id`)
      .all({ $id: issueId }) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.to_issue ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
    }));
  }

  private getDependents(issueId: string): BeadDependency[] {
    const rows = this.db
      .query(`SELECT d.from_issue, d.dependency_type, i.title, i.status FROM dependencies d JOIN issues i ON d.from_issue = i.id WHERE d.to_issue = $id`)
      .all({ $id: issueId }) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.from_issue ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocked_by") as BeadDependency["dependency_type"],
    }));
  }

  private getRelatedIds(issueId: string): string[] {
    try {
      const rows = this.db
        .query(`SELECT related_issue_id FROM issue_related WHERE issue_id = $id`)
        .all({ $id: issueId } as any) as Array<Record<string, unknown>>;

      return rows.map((row) => String(row.related_issue_id ?? "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  private getLabels(issueId: string): string[] {
    const rows = this.db
      .query(`SELECT label FROM issue_labels WHERE issue_id = $id`)
      .all({ $id: issueId }) as Array<Record<string, unknown>>;

    return rows.map((row) => String(row.label ?? "")).filter(Boolean);
  }
}
