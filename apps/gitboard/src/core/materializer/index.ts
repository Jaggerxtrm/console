import type { Database } from "bun:sqlite";
import type { ChannelRegistry } from "../../api/ws/channels.ts";
import { emit, makeLogEntry } from "../logger.ts";
import { bump as bumpEpoch } from "../../server/observability/epoch.ts";
import { createAdapterRegistry, type AdapterRegistry } from "./adapter.ts";
import { COALESCE_MS, SourceQueue } from "./queue.ts";
import type { MaterializerAdapter } from "./types.ts";

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

  register<TRow, TDependency>(sourceKey: string, adapter: MaterializerAdapter<TRow, TDependency>): void {
    this.registry.set(sourceKey, adapter);
    if (!this.queues.has(sourceKey)) this.queues.set(sourceKey, new SourceQueue());
  }

  trigger(sourceKey: string): void {
    const queue = this.queues.get(sourceKey);
    if (!queue) throw new Error(`unknown source: ${sourceKey}`);
    queue.enqueue(sourceKey, () => this.runOnce(sourceKey));
  }

  async runOnce(sourceKey: string): Promise<void> {
    const startedAt = Date.now();
    const adapter = this.registry.get(sourceKey);
    if (!adapter) throw new Error(`unknown source: ${sourceKey}`);

    const currentCursor = await this.getCursor(sourceKey);
    const baselineCursor = currentCursor ?? (await adapter.cursor());
    const next = await adapter.changesSince(baselineCursor);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      adapter.write(this.db, next);
      this.upsertMaterializationState(sourceKey, JSON.stringify(next.cursor));
      this.hooks.afterWritesBeforeCursorAdvance?.(sourceKey);
      this.db.exec("COMMIT");
      if (sourceKey.startsWith("obs:")) bumpEpoch(sourceKey.slice(4));
      this.markSuccess(sourceKey);
    } catch (error) {
      this.db.exec("ROLLBACK");
      await this.markFailure(sourceKey, error);
      throw error;
    }

    this.publishHint(sourceKey);
    emit(makeLogEntry("system", "materializer.run", "info", undefined, { source_key: sourceKey, duration_ms: Date.now() - startedAt, rows_written: next.rows.length, dependencies_written: next.dependencies?.length ?? 0 }));
  }

  async resync(sourceKey: string): Promise<void> {
    const adapter = this.registry.get(sourceKey);
    if (!adapter) throw new Error(`unknown source: ${sourceKey}`);
    const snapshot = await adapter.snapshot();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      adapter.write(this.db, snapshot);
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
    if (sourceKey.startsWith("beads:")) {
      const projectId = sourceKey.slice(6);
      return { channels: ["beads:changes", `beads:project:${projectId}`], event: "beads:sync_hint" };
    }
    return { channels: ["system"], event: "materializer:hint" };
  }

  private async getCursor(sourceKey: string): Promise<unknown> {
    const row = this.db.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(sourceKey) as { cursor: string | null } | undefined;
    if (!row?.cursor) return null;
    try {
      return JSON.parse(row.cursor);
    } catch {
      emit(makeLogEntry("system", "materializer.cursor.invalid", "warn", undefined, { source_key: sourceKey, cursor: row.cursor }));
      return null;
    }
  }

  private upsertMaterializationState(sourceKey: string, cursor: string): void {
    this.db.query("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, 'running') ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor, last_run_at=excluded.last_run_at, last_status=excluded.last_status, last_error=NULL").run(sourceKey, cursor);
  }

  private markSuccess(sourceKey: string): void {
    this.db.query("UPDATE materialization_state SET last_status = 'success', last_success_at = CURRENT_TIMESTAMP, last_error = NULL WHERE source_key = ?").run(sourceKey);
  }

  private async markFailure(sourceKey: string, error: unknown): Promise<void> {
    this.db.query("INSERT INTO materialization_state (source_key, last_run_at, last_status, last_error) VALUES (?, CURRENT_TIMESTAMP, 'error', ?) ON CONFLICT(source_key) DO UPDATE SET last_run_at=excluded.last_run_at, last_status=excluded.last_status, last_error=excluded.last_error").run(sourceKey, error instanceof Error ? error.message : String(error));
  }
}
