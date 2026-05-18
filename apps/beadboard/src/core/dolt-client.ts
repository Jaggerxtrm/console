/**
 * DoltClient - MySQL client for dolt database connections
 */

import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { BeadIssue, BeadDependency, IssueFilters, BeadIssueDetail, ProjectSourceHealth } from "../types/beads.ts";

export interface DoltConfig {
  host: string;
  port: number;
  user?: string;
  database?: string;
}

export class DoltClient {
  private connection: Connection | null = null;
  private config: DoltConfig;

  constructor(config: DoltConfig) {
    this.config = {
      database: "dolt",
      ...config,
      user: config.user ?? "root",
    };
  }

  async connect(): Promise<void> {
    if (this.connection) return;

    this.connection = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      database: this.config.database,
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  async getIssues(filters: IssueFilters = {}): Promise<BeadIssue[]> {
    const rows = await this.selectIssues(filters);
    const issues: BeadIssue[] = [];
    for (const row of rows) issues.push(await this.toIssue(row));
    return issues;
  }

  async getCommitHash(): Promise<string> {
    await this.connect();
    const [rows] = await this.connection!.execute<RowDataPacket[]>("SELECT current_branch() AS branch, current_commit() AS commit_hash");
    const row = rows[0] as RowDataPacket | undefined;
    return String(row?.commit_hash ?? row?.hash ?? row?.commit ?? "");
  }

  async getIssuesSince(updatedSince: string): Promise<BeadIssue[]> {
    return this.getIssues({ limit: 1000, offset: 0, search: undefined }).then((issues) => issues.filter((issue) => issue.updated_at > updatedSince));
  }

  async getIssue(issueId: string): Promise<BeadIssueDetail | null> {
    const [row] = await this.selectIssues({ limit: 1, offset: 0 }, issueId);
    if (!row) return null;

    const issue = await this.toIssue(row);
    return {
      ...issue,
      dependents: await this.getDependents(issueId),
      children: (await this.getDependents(issueId)).filter((dependency) => dependency.dependency_type === "parent-child"),
      source: "dolt",
      sourceHealth: [{ kind: "dolt", state: "available" }],
    };
  }

  async fetchIssuesSince(updatedSince: string): Promise<BeadIssue[]> {
    return this.getIssuesSince(updatedSince);
  }

  private async selectIssues(filters: IssueFilters, issueId?: string): Promise<RowDataPacket[]> {
    await this.connect();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (issueId) {
      conditions.push("id = ?");
      params.push(issueId);
    }
    if (filters.status?.length) {
      conditions.push(`status IN (${filters.status.map(() => "?").join(", ")})`);
      params.push(...filters.status);
    }
    if (filters.priority?.length) {
      conditions.push(`priority IN (${filters.priority.map(() => "?").join(", ")})`);
      params.push(...filters.priority);
    }
    if (filters.issue_type?.length) {
      conditions.push(`issue_type IN (${filters.issue_type.map(() => "?").join(", ")})`);
      params.push(...filters.issue_type);
    }
    if (filters.search) {
      conditions.push("(title LIKE ? OR description LIKE ?)");
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT *
       FROM issues
       ${where}
       ORDER BY priority ASC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return rows;
  }

  private async toIssue(row: RowDataPacket): Promise<BeadIssue> {
    return {
      id: String(row.id),
      title: String(row.title ?? ""),
      description: row.description ?? null,
      notes: row.notes ?? null,
      status: String(row.status ?? "open") as BeadIssue["status"],
      priority: Number(row.priority ?? 2) as BeadIssue["priority"],
      issue_type: String(row.issue_type ?? "task") as BeadIssue["issue_type"],
      owner: row.owner ?? null,
      created_at: String(row.created_at ?? ""),
      created_by: row.created_by ?? null,
      updated_at: String(row.updated_at ?? row.created_at ?? ""),
      closed_at: row.closed_at ?? undefined,
      close_reason: row.close_reason ?? undefined,
      project_id: "",
      dependencies: await this.getDependencies(String(row.id)),
      parent_id: row.parent_id ?? undefined,
      related_ids: await this.getRelatedIds(String(row.id)),
      labels: await this.getLabels(String(row.id)),
    };
  }

  private async getDependencies(issueId: string): Promise<BeadDependency[]> {
    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT d.depends_on_id as id, d.type as dependency_type, i.title, i.status
       FROM dependencies d
       JOIN issues i ON d.depends_on_id = i.id
       WHERE d.issue_id = ?`,
      [issueId]
    );

    return (rows as RowDataPacket[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocks") as BeadDependency["dependency_type"],
    }));
  }

  private async getDependents(issueId: string): Promise<BeadDependency[]> {
    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT d.issue_id as id, d.type as dependency_type, i.title, i.status
       FROM dependencies d
       JOIN issues i ON d.issue_id = i.id
       WHERE d.depends_on_id = ?`,
      [issueId]
    );

    return (rows as RowDataPacket[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      status: String(row.status ?? "open") as BeadDependency["status"],
      dependency_type: String(row.dependency_type ?? "blocked_by") as BeadDependency["dependency_type"],
    }));
  }

  private async getRelatedIds(issueId: string): Promise<string[]> {
    try {
      const [rows] = await this.connection!.execute<RowDataPacket[]>(
        "SELECT related_issue_id FROM issue_related WHERE issue_id = ?",
        [issueId]
      );
      return (rows as RowDataPacket[]).map((row) => String(row.related_issue_id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async getLabels(issueId: string): Promise<string[]> {
    try {
      const [rows] = await this.connection!.execute<RowDataPacket[]>(
        "SELECT label FROM labels WHERE issue_id = ?",
        [issueId]
      );
      return (rows as RowDataPacket[]).map((row) => String(row.label)).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getClosedIssues(limit: number = 50): Promise<BeadIssue[]> {
    await this.connect();

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT *
       FROM issues
       WHERE status = 'closed' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC
       LIMIT ?`,
      [limit]
    );

    const issues: BeadIssue[] = [];
    for (const row of rows) issues.push(await this.toIssue(row));
    return issues;
  }

  async getStats(): Promise<{ total: number; open: number; in_progress: number; blocked: number; closed: number }> {
    await this.connect();

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
       FROM issues`
    );

    const row = rows[0];
    return {
      total: Number(row.total ?? 0),
      open: Number(row.open ?? 0),
      in_progress: Number(row.in_progress ?? 0),
      blocked: Number(row.blocked ?? 0),
      closed: Number(row.closed ?? 0),
    };
  }
}
