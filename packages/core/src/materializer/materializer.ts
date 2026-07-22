import type { Database } from "bun:sqlite";
import { createAdapterRegistry, type AdapterRegistry } from "./adapter.ts";
import { BoundedMaterializerScheduler, SourceQueue, type MaterializerSchedulerStats } from "./queue.ts";
import type { MaterializerAdapter } from "./types.ts";

export type MaterializerLogLevel = "debug" | "info" | "warn" | "error";
export type MaterializerLogComponent = "system" | "ws";

export interface MaterializerLogEntry {
  component: MaterializerLogComponent;
  event: string;
  level: MaterializerLogLevel;
  message?: string;
  data?: Record<string, unknown>;
}

export interface MaterializerRealtimePublisher {
  publish(channel: any, event: string, data: Record<string, unknown>, version: string): void;
}

export interface MaterializerHooks {
  afterWritesBeforeCursorAdvance?: (sourceKey: string) => void;
  emitLog?: (entry: MaterializerLogEntry) => void;
  bumpObservabilityEpoch?: (repoSlug: string) => void;
}

export class Materializer {
  private readonly registry: AdapterRegistry = createAdapterRegistry();
  private readonly queues = new Map<string, SourceQueue>();
  private readonly scheduler = new BoundedMaterializerScheduler();

  constructor(
    private readonly db: Database,
    private readonly wsRegistry?: MaterializerRealtimePublisher,
    private readonly hooks: MaterializerHooks = {},
  ) {}

  register<TRow, TDependency>(sourceKey: string, adapter: MaterializerAdapter<TRow, TDependency>): void {
    this.registry.set(sourceKey, adapter);
    if (!this.queues.has(sourceKey)) {
      this.queues.set(sourceKey, new SourceQueue((failedSourceKey, error) => {
        this.emitLog("system", "materializer.error", "error", undefined, { source_key: failedSourceKey, error: error instanceof Error ? error.message : String(error) });
      }));
    }
  }

  trigger(sourceKey: string): void {
    const queue = this.queues.get(sourceKey);
    if (!queue) throw new Error(`unknown source: ${sourceKey}`);
    queue.enqueue(sourceKey, () => this.schedule(sourceKey));
  }

  getSchedulerStats(): MaterializerSchedulerStats {
    return this.scheduler.getStats();
  }

  private schedule(sourceKey: string): Promise<void> {
    const scheduled = this.scheduler.submit(sourceKey, () => this.runOnce(sourceKey));
    if (scheduled.accepted) return scheduled.completion;
    this.queues.get(sourceKey)?.enqueue(sourceKey, () => this.schedule(sourceKey));
    return Promise.resolve();
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
      this.writeMaterializerForensicEvent(sourceKey, "materializer.run.completed", "info", {
        rows_written: next.rows.length,
        dependencies_written: next.dependencies?.length ?? 0,
        forensic_events_written: next.forensicEvents?.length ?? 0,
        evidence_refs_written: next.evidenceRefs?.length ?? 0,
        cursor: next.cursor,
      }, startedAt);
      this.hooks.afterWritesBeforeCursorAdvance?.(sourceKey);
      this.db.exec("COMMIT");
      if (sourceKey.startsWith("obs:")) this.hooks.bumpObservabilityEpoch?.(sourceKey.slice(4));
      this.markSuccess(sourceKey);
    } catch (error) {
      this.db.exec("ROLLBACK");
      await this.markFailure(sourceKey, error);
      this.writeMaterializerFailureEvent(sourceKey, error, startedAt);
      throw error;
    }

    this.publishHint(sourceKey);
    const counts = this.countMaterializedIssueVariants(sourceKey);
    this.emitLog("system", "materializer.run", "info", undefined, { source_key: sourceKey, duration_ms: Date.now() - startedAt, rows_written: next.rows.length, dependencies_written: next.dependencies?.length ?? 0, rows_with_real_priority: counts.rows_with_real_priority, rows_with_real_type: counts.rows_with_real_type, rows_with_labels: counts.rows_with_labels });
  }

  async resync(sourceKey: string): Promise<void> {
    const adapter = this.registry.get(sourceKey);
    if (!adapter) throw new Error(`unknown source: ${sourceKey}`);
    const snapshot = await adapter.snapshot();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const writer = adapter.writeFull ?? adapter.write;
      writer.call(adapter, this.db, snapshot);
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
    this.emitLog("system", "materializer.publishHint", "info", undefined, {
      source_key: sourceKey,
      event: hint.event,
      channels: hint.channels,
      ws_registry_set: this.wsRegistry != null,
      ...(kind ? { kind } : {}),
    });
    const data = { source_key: sourceKey, ...hint.data, ...(kind ? { kind } : {}) };
    for (const channel of hint.channels) {
      this.emitLog("ws", "channel.publish", "debug", undefined, {
        component: "ws",
        event: "channel.publish",
        source_key: sourceKey,
        channel,
        realtime_event: hint.event,
        ...(kind ? { kind } : {}),
      });
      this.wsRegistry?.publish(channel, hint.event, data, String(Date.now()));
    }
  }

  private realtimeHintFor(sourceKey: string): { channels: string[]; event: string; data?: Record<string, unknown> } | null {
    if (sourceKey.startsWith("obs:")) {
      const repoSlug = sourceKey.slice(4);
      return { channels: ["specialists:activity", `specialists:repo:${repoSlug}`], event: "specialists:sync_hint", data: { repoSlug, repo_slug: repoSlug } };
    }
    if (sourceKey.startsWith("beads:")) {
      const projectId = sourceKey.slice(6);
      return { channels: ["substrate:changes", `substrate:project:${projectId}`], event: "substrate:sync_hint", data: { projectId, project_id: projectId } };
    }
    return { channels: ["system"], event: "materializer:hint" };
  }

  private async getCursor(sourceKey: string): Promise<unknown> {
    const row = this.db.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get(sourceKey) as { cursor: string | null } | undefined;
    if (!row?.cursor) return null;
    try {
      return JSON.parse(row.cursor);
    } catch {
      this.emitLog("system", "materializer.cursor.invalid", "warn", undefined, { source_key: sourceKey, cursor: row.cursor });
      return null;
    }
  }

  private countMaterializedIssueVariants(sourceKey: string): { rows_with_real_priority: number; rows_with_real_type: number; rows_with_labels: number } {
    const projectId = sourceKey.replace(/^beads:/, "");
    const row = this.db.query("SELECT SUM(CASE WHEN priority IS NOT NULL AND priority <> 2 THEN 1 ELSE 0 END) AS rows_with_real_priority, SUM(CASE WHEN issue_type IS NOT NULL AND issue_type <> 'task' THEN 1 ELSE 0 END) AS rows_with_real_type, SUM(CASE WHEN labels IS NOT NULL AND labels <> '[]' AND labels <> '' THEN 1 ELSE 0 END) AS rows_with_labels FROM substrate_issues WHERE repo_slug = ?").get(projectId) as { rows_with_real_priority: number | null; rows_with_real_type: number | null; rows_with_labels: number | null } | undefined;
    return { rows_with_real_priority: Number(row?.rows_with_real_priority ?? 0), rows_with_real_type: Number(row?.rows_with_real_type ?? 0), rows_with_labels: Number(row?.rows_with_labels ?? 0) };
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

  private writeMaterializerForensicEvent(sourceKey: string, eventName: string, severity: "info" | "warn" | "error", body: Record<string, unknown>, startedAt: number): void {
    const tUnixMs = Date.now();
    const envelope = {
      schema_version: "xtrm.forensic.v1",
      timestamp: new Date(tUnixMs).toISOString(),
      t_unix_ms: tUnixMs,
      severity,
      event_family: "materializer",
      event_name: eventName,
      event_version: 1,
      resource: {
        service_namespace: "xtrm",
        service_name: "gitboard",
        service_component: "materializer",
        deployment_environment: process.env.NODE_ENV ?? "local",
        repo: this.repoSlugFor(sourceKey),
        participant_kind: "adapter",
        participant_role: "materializer",
      },
      correlation: { source_key: sourceKey },
      body: { ...body, duration_ms: tUnixMs - startedAt },
      redaction: { status: "clean" },
    };
    this.db.query(`
      INSERT INTO xtrm_forensic_events (
        source_key, source_event_id, repo_slug, job_id, seq, t_unix_ms, timestamp, schema_version, severity,
        event_family, event_name, event_version, resource_json, correlation_json, body_json, redaction_json, envelope_json
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, source_event_id) DO NOTHING
    `).run(
      `materializer:${sourceKey}`,
      `${eventName}:${startedAt}:${tUnixMs}`,
      this.repoSlugFor(sourceKey),
      tUnixMs,
      envelope.timestamp,
      envelope.schema_version,
      envelope.severity,
      envelope.event_family,
      envelope.event_name,
      envelope.event_version,
      JSON.stringify(envelope.resource),
      JSON.stringify(envelope.correlation),
      JSON.stringify(envelope.body),
      JSON.stringify(envelope.redaction),
      JSON.stringify(envelope),
    );
  }

  private writeMaterializerFailureEvent(sourceKey: string, error: unknown, startedAt: number): void {
    try {
      this.writeMaterializerForensicEvent(sourceKey, "materializer.run.failed", "error", {
        error_type: error instanceof Error ? error.name : "Error",
        message_redacted: error instanceof Error ? error.message : String(error),
      }, startedAt);
    } catch {
      // Failure telemetry is best-effort; materialization failure handling must not fail recursively.
    }
  }

  private repoSlugFor(sourceKey: string): string {
    return sourceKey.replace(/^(obs|beads):/, "") || "unknown";
  }

  private emitLog(component: MaterializerLogComponent, event: string, level: MaterializerLogLevel, message?: string, data?: Record<string, unknown>): void {
    this.hooks.emitLog?.({ component, event, level, message, data });
  }
}
