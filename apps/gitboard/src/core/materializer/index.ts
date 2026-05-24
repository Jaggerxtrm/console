import type { Database } from "bun:sqlite";
import type { ChannelRegistry } from "../../api/ws/channels.ts";
import { emit, makeLogEntry } from "../logger.ts";
import { createAdapterRegistry, type AdapterRegistry } from "./adapter.ts";
import { COALESCE_MS, SourceQueue } from "./queue.ts";
import type { MaterializedDependency, MaterializedIssue, MaterializerAdapter } from "./types.ts";

type MaterializerHooks = {
  afterWritesBeforeCursorAdvance?: (sourceKey: string) => void;
};

export class Materializer {
  private readonly registry: AdapterRegistry = createAdapterRegistry();
  private readonly queues = new Map<string, SourceQueue>();

  constructor(
    private readonly db: Database,
    private readonly wsRegistry?: ChannelRegistry,
    private readonly hooks: MaterializerHooks = {},
  ) {}

  register(sourceKey: string, adapter: MaterializerAdapter): void {
    this.registry.set(sourceKey, adapter);
    if (!this.queues.has(sourceKey)) this.queues.set(sourceKey, new SourceQueue());
  }

  trigger(sourceKey: string): void {
    const queue = this.queues.get(sourceKey);
    if (!queue) throw new Error(`unknown source: ${sourceKey}`);
    queue.enqueue(() => this.runOnce(sourceKey));
  }

  async runOnce(sourceKey: string): Promise<void> {
    const adapter = this.registry.get(sourceKey);
    if (!adapter) throw new Error(`unknown source: ${sourceKey}`);

    const currentCursor = await this.getCursor(sourceKey);
    const baselineCursor = currentCursor ?? (await adapter.cursor());
    const next = await adapter.changesSince(baselineCursor);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeIssues(next.rows);
      this.replaceDependencies(next.dependencies ?? [], next.rows);
      this.upsertMaterializationState(sourceKey, JSON.stringify(next.cursor));
      this.hooks.afterWritesBeforeCursorAdvance?.(sourceKey);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      await this.markFailure(sourceKey, error);
      throw error;
    }

    this.publishHint(sourceKey);
    emit(makeLogEntry("system", "materializer.run", "info", undefined, { source_key: sourceKey, coalesce_ms: COALESCE_MS }));
  }

  async resync(sourceKey: string): Promise<void> {
    const adapter = this.registry.get(sourceKey);
    if (!adapter) throw new Error(`unknown source: ${sourceKey}`);
    const snapshot = await adapter.snapshot();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeIssues(snapshot.rows);
      this.replaceDependencies(snapshot.dependencies ?? [], snapshot.rows);
      this.tombstoneMissing(snapshot.rows);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.publishHint(sourceKey, "resync");
  }

  private publishHint(sourceKey: string, kind?: string): void {
    const hint = this.realtimeHintFor(sourceKey);
    if (!hint) return;
    for (const channel of hint.channels) {
      this.wsRegistry?.publish(channel as Parameters<ChannelRegistry["publish"]>[0], hint.event, { source_key: sourceKey, ...(kind ? { kind } : {}) }, String(Date.now()));
    }
  }

  private realtimeHintFor(sourceKey: string): { channels: string[]; event: string } | null {
    if (sourceKey.startsWith("obs:")) {
      const repoSlug = sourceKey.slice(4);
      return { channels: ["specialists:activity", `specialists:repo:${repoSlug}`], event: "specialists:sync_hint" };
    }
    return { channels: ["system"], event: "materializer:hint" };
  }

  private writeIssues(rows: readonly MaterializedIssue[]): void {
    const stmt = this.db.query("INSERT INTO substrate_issues (repo_slug, issue_id, title, body, state, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id) DO UPDATE SET title=excluded.title, body=excluded.body, state=excluded.state, deleted_at=excluded.deleted_at, created_at=excluded.created_at, updated_at=excluded.updated_at");
    for (const row of rows) {
      stmt.run(row.repo_slug, row.issue_id, row.title ?? null, row.body ?? null, row.state, row.deleted_at ?? null, row.created_at ?? null, row.updated_at ?? null);
    }
  }

  private replaceDependencies(rows: readonly MaterializedDependency[], issues: readonly MaterializedIssue[]): void {
    this.deleteDependencies(issues);
    const stmt = this.db.query("INSERT INTO substrate_dependencies (repo_slug, issue_id, dep_issue_id, relation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_slug, issue_id, dep_issue_id) DO UPDATE SET relation=excluded.relation, created_at=excluded.created_at");
    for (const row of rows) stmt.run(row.repo_slug, row.issue_id, row.dep_issue_id, row.relation, row.created_at ?? null);
  }

  private deleteDependencies(issues: readonly MaterializedIssue[]): void {
    const stmt = this.db.query("DELETE FROM substrate_dependencies WHERE repo_slug = ? AND issue_id = ?");
    for (const row of issues) stmt.run(row.repo_slug, row.issue_id);
  }

  private tombstoneMissing(rows: readonly MaterializedIssue[]): void {
    const keys = new Set(rows.map((row) => `${row.repo_slug}::${row.issue_id}`));
    const active = this.db.query("SELECT repo_slug, issue_id FROM substrate_issues WHERE deleted_at IS NULL").all() as Array<{ repo_slug: string; issue_id: string }>;
    const stmt = this.db.query("UPDATE substrate_issues SET deleted_at = CURRENT_TIMESTAMP, state = 'deleted' WHERE repo_slug = ? AND issue_id = ?");
    for (const row of active) {
      if (!keys.has(`${row.repo_slug}::${row.issue_id}`)) stmt.run(row.repo_slug, row.issue_id);
    }
  }

  private async getCursor(sourceKey: string): Promise<unknown> {
    const row = this.db.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(sourceKey) as { cursor: string | null } | undefined;
    return row?.cursor ? JSON.parse(row.cursor) : null;
  }

  private upsertMaterializationState(sourceKey: string, cursor: string): void {
    this.db.query("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, 'running') ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor, last_run_at=excluded.last_run_at, last_status=excluded.last_status, last_error=NULL").run(sourceKey, cursor);
  }

  private async markFailure(sourceKey: string, error: unknown): Promise<void> {
    this.db.query("INSERT INTO materialization_state (source_key, last_run_at, last_status, last_error) VALUES (?, CURRENT_TIMESTAMP, 'error', ?) ON CONFLICT(source_key) DO UPDATE SET last_run_at=excluded.last_run_at, last_status=excluded.last_status, last_error=excluded.last_error").run(sourceKey, error instanceof Error ? error.message : String(error));
  }
}
