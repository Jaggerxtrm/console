/**
 * DoltClient - MySQL client for dolt database connections
 */

import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import type { BeadIssue, BeadDependency, IssueFilters } from "../types/beads.ts";

export interface DoltConfig {
  host: string;
  port: number;
  user?: string;
  database?: string;
}

export class DoltClient {
  private connection: Connection | null = null;
  private config: DoltConfig;
  private dependencyColumns: Set<string> | null = null;

  constructor(config: DoltConfig) {
    this.config = {
      database: "dolt",
      ...config,
      user: config.user ?? "root",
    };
  }

  /**
   * Connect to the dolt database
   */
  async connect(): Promise<void> {
    if (this.connection) return;

    this.connection = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      database: this.config.database,
    });
  }

  /**
   * Close the connection
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connection !== null;
  }

  /**
   * Get issues with optional filters
   */
  async getIssues(filters: IssueFilters = {}): Promise<BeadIssue[]> {
    await this.connect();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...filters.status);
    }

    if (filters.priority && filters.priority.length > 0) {
      const placeholders = filters.priority.map(() => "?").join(", ");
      conditions.push(`priority IN (${placeholders})`);
      params.push(...filters.priority);
    }

    if (filters.issue_type && filters.issue_type.length > 0) {
      const placeholders = filters.issue_type.map(() => "?").join(", ");
      conditions.push(`issue_type IN (${placeholders})`);
      params.push(...filters.issue_type);
    }

    if (filters.search) {
      conditions.push("(title LIKE ? OR description LIKE ?)");
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT
        id, title, description, status, priority, issue_type,
        owner, created_at, created_by, updated_at, closed_at, close_reason
       FROM issues
       ${where}
       ORDER BY priority ASC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset] as any[]
    );

    // Batch-hydrate dependencies + labels with two IN-clause queries instead
    // of 2N round-trips. The per-row loop hung the /api/console/graph route on
    // large repos (unitAI ~hundreds of rows × 2 queries = >2k round-trips).
    const ids = rows.map((row) => row.id as string);
    const depsById = ids.length > 0 ? await this.getDependenciesBatch(ids) : new Map<string, BeadDependency[]>();
    const labelsById = ids.length > 0 ? await this.getLabelsBatch(ids) : new Map<string, string[]>();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status as BeadIssue["status"],
      priority: row.priority as BeadIssue["priority"],
      issue_type: row.issue_type as BeadIssue["issue_type"],
      owner: row.owner,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_at: row.updated_at ?? row.created_at,
      closed_at: row.closed_at ?? undefined,
      close_reason: row.close_reason ?? undefined,
      project_id: "", // Set by caller
      dependencies: depsById.get(row.id) ?? [],
      labels: labelsById.get(row.id) ?? [],
      related_ids: [],
    }));
  }

  private async getDependenciesBatch(issueIds: string[]): Promise<Map<string, BeadDependency[]>> {
    const placeholders = issueIds.map(() => "?").join(", ");
    const { issueColumn, targetColumn, typeColumn } = dependencyColumnMapping(await this.getDependencyColumns());
    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT d.${issueColumn} AS issue_id, d.${targetColumn} as id, d.${typeColumn} as dependency_type, i.title, i.status
       FROM dependencies d
       JOIN issues i ON d.${targetColumn} = i.id
       WHERE d.${issueColumn} IN (${placeholders})`,
      issueIds,
    );
    const byIssue = new Map<string, BeadDependency[]>();
    for (const row of rows) {
      const list = byIssue.get(row.issue_id) ?? [];
      list.push({
        id: row.id,
        title: row.title,
        status: row.status as BeadDependency["status"],
        dependency_type: row.dependency_type as BeadDependency["dependency_type"],
      });
      byIssue.set(row.issue_id, list);
    }
    return byIssue;
  }

  private async getDependencyColumns(): Promise<Set<string>> {
    if (this.dependencyColumns) return this.dependencyColumns;
    const [rows] = await this.connection!.execute<RowDataPacket[]>("SHOW COLUMNS FROM dependencies");
    this.dependencyColumns = new Set(rows.map((row) => String(row.Field)));
    return this.dependencyColumns;
  }

  private async getLabelsBatch(issueIds: string[]): Promise<Map<string, string[]>> {
    const placeholders = issueIds.map(() => "?").join(", ");
    try {
      const [rows] = await this.connection!.execute<RowDataPacket[]>(
        `SELECT issue_id, label FROM labels WHERE issue_id IN (${placeholders})`,
        issueIds,
      );
      const byIssue = new Map<string, string[]>();
      for (const row of rows) {
        const list = byIssue.get(row.issue_id) ?? [];
        list.push(row.label);
        byIssue.set(row.issue_id, list);
      }
      return byIssue;
    } catch {
      // `labels` table is optional in some Dolt schemas — fail soft.
      return new Map();
    }
  }

  /**
   * Get closed issues ordered by closed_at DESC
   */
  async getClosedIssues(limit: number = 50): Promise<BeadIssue[]> {
    await this.connect();

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT
        id, title, description, status, priority, issue_type,
        owner, created_at, created_by, updated_at, closed_at, close_reason
       FROM issues
       WHERE status = 'closed' AND closed_at IS NOT NULL
       ORDER BY closed_at DESC
       LIMIT ?`,
      [limit]
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: "closed" as const,
      priority: row.priority as BeadIssue["priority"],
      issue_type: row.issue_type as BeadIssue["issue_type"],
      owner: row.owner,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_at: row.updated_at ?? row.created_at,
      closed_at: row.closed_at ?? undefined,
      close_reason: row.close_reason ?? undefined,
      project_id: "",
      dependencies: [],
      labels: [],
      related_ids: [],
    }));
  }

  /**
   * Get issue count by status
   */
  async getStats(): Promise<{
    total: number;
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
  }> {
    await this.connect();

    const [rows] = await this.connection!.execute<RowDataPacket[]>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
       FROM issues`
    );

    const row = rows[0];
    return {
      total: row.total,
      open: row.open,
      in_progress: row.in_progress,
      blocked: row.blocked,
      closed: row.closed,
    };
  }
}

export function dependencyColumnMapping(schema: Set<string>): { issueColumn: string; targetColumn: string; typeColumn: string } {
  return {
    issueColumn: schema.has("issue_id") ? "issue_id" : "from_issue",
    targetColumn: schema.has("depends_on_issue_id")
      ? "depends_on_issue_id"
      : schema.has("depends_on_id")
        ? "depends_on_id"
        : "to_issue",
    typeColumn: schema.has("type") ? "type" : "dependency_type",
  };
}

export function doltPoolKey(config: DoltConfig): string {
  return `${config.host}:${config.port}/${config.database ?? "dolt"}/${config.user ?? "root"}`;
}
