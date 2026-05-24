import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ChannelRegistry } from "../../../gitboard/src/api/ws/channels.ts";
import type { BeadDependency, BeadIssue, BeadsProject, Memory } from "../types/beads.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { DoltClient } from "./dolt-client.ts";
import { BeadsReader } from "./beads-reader.ts";
import { emit, makeLogEntry } from "../../../gitboard/src/core/logger.ts";

// forge-h830: the 2s interval was hammering Dolt with getCommitHash + readSnapshot
// for every tracked project (25 × every 2s = 12 qps just for this watcher),
// causing slow-query / circuit-breaker cascades on the shared 3308 server and
// generating ~50 WS batches/sec of mostly redundant events. fs.watch on each
// project's issues.jsonl (see ensureWatcher) already provides ~1s-latency real-
// time signal for actual changes; the interval is just a backup heartbeat and
// can run much less often without hurting user-visible freshness.
const ACTIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 60_000;
const WATCH_DEBOUNCE_MS = 1_000;
const COALESCE_MS = 1_500;
const MAX_BATCH = 50;

type Snapshot = { issues: BeadIssue[]; deps: BeadDependency[]; memories: Memory[]; kv: Array<{ key: string; value: unknown; project_id: string }> };
type PendingEvent = { projectId: string; source: "dolt" | "jsonl" | "sqlite"; version: string; event: string; data: Record<string, unknown> };

export class BeadsChangeWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private watchers = new Map<string, FSWatcher>();
  private previous = new Map<string, Snapshot>();
  private lastCommitHash = new Map<string, string>();
  private queue: PendingEvent[] = [];
  private lastHealth = new Map<string, boolean>();

  constructor(private readonly options: { scanner?: ProjectScanner; registry: ChannelRegistry; triggerMaterializer?: (project: BeadsProject) => void }) {}

  private get scanner(): ProjectScanner {
    return this.options.scanner ?? new ProjectScanner({ searchPath: process.env.XDG_PROJECTS_DIR || "/home" });
  }
  private get registry(): ChannelRegistry { return this.options.registry; }

  start(): void { void this.loop(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.flushTimer) clearTimeout(this.flushTimer); for (const watcher of this.watchers.values()) watcher.close(); }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const projects = await this.scanner.scanAll();
    for (const project of projects) {
      await this.ensureWatcher(project);
      await this.poll(project);
    }
    this.timer = setTimeout(() => void this.loop(), projects.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  private async ensureWatcher(project: BeadsProject): Promise<void> {
    if (this.watchers.has(project.id)) return;
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const watcher = watch(join(project.beadsPath, "issues.jsonl"), { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void this.poll(project), WATCH_DEBOUNCE_MS);
      });
      this.watchers.set(project.id, watcher);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") console.error("[beads-change-watcher] watch failed", project.id, error);
    }
  }

  private async poll(project: BeadsProject): Promise<void> {
    if (this.options.triggerMaterializer) {
      this.options.triggerMaterializer(project);
      return;
    }
    const commitHash = await this.getCommitHash(project);
    const prevHash = this.lastCommitHash.get(project.id);
    const haveSnapshot = this.previous.has(project.id);

    // Fast path: commit hash unchanged AND we already have a snapshot →
    // nothing diffed since last tick. Emit health and skip the expensive
    // readSnapshot (which would otherwise SELECT up to 1000 rows + 3 batched
    // IN-clause hydration queries per project per 2s on a stable repo).
    if (commitHash && prevHash === commitHash && haveSnapshot) {
      emit(makeLogEntry("watcher", "poll.skipped", "debug", undefined, { projectId: project.id }));
      this.enqueue({
        projectId: project.id,
        source: "dolt",
        version: commitHash,
        event: "beads:source_health",
        data: { projectId: project.id, source: "dolt", drift: false, healthy: true },
      });
      return;
    }

    emit(makeLogEntry("watcher", "poll.snapshot_read", "info", undefined, { projectId: project.id }));
    const snapshotStartedAt = performance.now();
    const snapshot = await this.readSnapshot(project);
    const previous = this.previous.get(project.id);
    const drift = Boolean(previous && previous.issues.length !== snapshot.issues.length);
    emit(makeLogEntry("watcher", "poll.snapshot_result", "info", undefined, {
      projectId: project.id,
      source: commitHash ? "dolt" : "jsonl",
      version: commitHash ?? null,
      ms: Math.round(performance.now() - snapshotStartedAt),
      issues: snapshot.issues.length,
      deps: snapshot.deps.length,
      memories: snapshot.memories.length,
      drift,
      initial: !previous,
    }));
    this.previous.set(project.id, snapshot);
    if (commitHash) this.lastCommitHash.set(project.id, commitHash);
    const healthy = Boolean(commitHash);
    const priorHealthy = this.lastHealth.get(project.id);
    if (priorHealthy !== healthy) {
      this.lastHealth.set(project.id, healthy);
      emit(makeLogEntry("watcher", "source_health.changed", "info", undefined, { projectId: project.id, healthy, source: commitHash ? "dolt" : "jsonl" }));
    }
    // forge-h830: the cached commit hash MUST persist across stable-state polls
    // for the fast-path check at L72 to work. The prior `else this.lastCommitHash.delete()`
    // here actively defeated that optimization — every poll for a healthy project
    // would then refetch the full snapshot (1000 rows + 3 hydration queries),
    // diff it (producing ~50 upsert events that overflow the batch), and flush
    // ~60 publishes/sec to WS subscribers. Removing the delete restores the
    // intended "skip readSnapshot when commit hash unchanged" semantics.
    if (drift) emit(makeLogEntry("watcher", "drift.detected", "warn", undefined, { projectId: project.id }));
    this.enqueue({ projectId: project.id, source: commitHash ? "dolt" : "jsonl", version: commitHash ?? String(Date.now()), event: "beads:source_health", data: { projectId: project.id, source: commitHash ? "dolt" : "jsonl", drift, healthy } });
    this.diffAndQueue(project.id, previous, snapshot, commitHash ?? String(Date.now()));
  }

  private diffAndQueue(projectId: string, previous: Snapshot | undefined, next: Snapshot, version: string): void {
    const prevIssues = new Map(previous?.issues.map((issue) => [issue.id, issue]) ?? []);
    const nextIssues = new Map(next.issues.map((issue) => [issue.id, issue]));
    if (!previous) {
      emit(makeLogEntry("watcher", "beads.snapshot.initialized", "info", undefined, {
        projectId,
        version,
        issues: next.issues.length,
        newestIssue: newestIssueSummary(next.issues),
      }));
    }
    for (const issue of next.issues) {
      const before = prevIssues.get(issue.id);
      if (previous && !before) {
        emit(makeLogEntry("watcher", "beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "created",
          issue: summarizeIssue(issue),
        }));
      } else if (before && before.status !== issue.status) {
        emit(makeLogEntry("watcher", "beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "status",
          issue: summarizeIssue(issue),
          previousStatus: before.status,
        }));
      } else if (before && before.updated_at !== issue.updated_at) {
        emit(makeLogEntry("watcher", "beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "updated",
          issue: summarizeIssue(issue),
          previousUpdatedAt: before.updated_at,
        }));
      }
      this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.upsert", data: { issue } });
      if (before?.status !== "closed" && issue.status === "closed") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.close", data: { issueId: issue.id } });
      if (!before && issue.status === "closed") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.close", data: { issueId: issue.id } });
      if (!before?.labels?.length && issue.labels.length > 0) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.flagged", data: { issue } });
      if (before?.labels?.length && issue.labels.length === 0) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.unflagged", data: { issue } });
      if (before?.parent_id == null && issue.parent_id != null) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.superseded", data: { issue } });
      if (before?.status !== "deferred" && issue.status === "deferred") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.deferred", data: { issue } });
    }
    for (const issue of previous?.issues ?? []) if (!nextIssues.has(issue.id)) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.delete", data: { issueId: issue.id } });
    this.diffList<Record<string, unknown>>(projectId, previous?.deps as unknown as Record<string, unknown>[] ?? [], next.deps as unknown as Record<string, unknown>[], version, "beads:dep.upsert", "beads:dep.delete", "id");
    this.diffList<Record<string, unknown>>(projectId, previous?.memories as unknown as Record<string, unknown>[] ?? [], next.memories as unknown as Record<string, unknown>[], version, "beads:memory.upsert", "beads:memory.delete", "id");
    this.diffList(projectId, previous?.kv ?? [], next.kv, version, "beads:kv.upsert", "beads:kv.delete", "key");
  }

  private diffList<T extends Record<string, unknown>>(projectId: string, previous: T[], next: T[], version: string, upsertEvent: string, deleteEvent: string, key: keyof T): void {
    const nextIds = new Set(next.map((item) => String(item[key])));
    for (const item of next) this.enqueue({ projectId, source: "dolt", version, event: upsertEvent, data: { [key]: item[key], ...item } });
    for (const item of previous) if (!nextIds.has(String(item[key]))) this.enqueue({ projectId, source: "dolt", version, event: deleteEvent, data: { [key]: item[key] } });
  }

  private enqueue(event: PendingEvent): void {
    this.queue.push(event);
    if (this.queue.length >= MAX_BATCH) { this.flush(true); return; }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(false), COALESCE_MS);
  }

  private flush(overflow: boolean): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    emit(makeLogEntry("watcher", "batch.published", "info", undefined, {
      count: batch.length,
      overflow: overflow || batch.length > MAX_BATCH,
      projectIds: uniqueProjectIds(batch),
      eventCounts: countEvents(batch),
      issueEvents: summarizeIssueEvents(batch),
    }));
    if (overflow || batch.length > MAX_BATCH) {
      emit(makeLogEntry("watcher", "batch.overflow_sync_hint", "warn", undefined, {
        count: batch.length,
        projectIds: uniqueProjectIds(batch),
        eventCounts: countEvents(batch),
        version: batch.at(-1)?.version ?? null,
      }));
      this.registry.publish("beads:changes", "beads:sync_hint", { reason: "overflow" }, batch.at(-1)?.version);
      return;
    }
    const grouped = new Map<string, PendingEvent[]>();
    for (const item of batch) grouped.set(item.projectId, [...(grouped.get(item.projectId) ?? []), item]);
    for (const [projectId, events] of grouped) {
      emit(makeLogEntry("watcher", "beads.batch.project_published", "info", undefined, {
        projectId,
        count: events.length,
        eventCounts: countEvents(events),
        issueEvents: summarizeIssueEvents(events),
        version: events.at(-1)?.version ?? null,
      }));
      this.registry.publish("beads:changes", "beads:batch", { project_id: projectId, issues: events.filter((e) => e.event === "beads:issue.upsert").map((e) => e.data.issue), dependencies: events.filter((e) => e.event === "beads:dep.upsert").map((e) => e.data as unknown as BeadDependency), memories: events.filter((e) => e.event === "beads:memory.upsert").map((e) => e.data as unknown as Memory), kv: events.filter((e) => e.event === "beads:kv.upsert").map((e) => e.data as { key: string; value: unknown; project_id: string }) }, events.at(-1)?.version);
    }
    for (const item of batch) this.registry.publish("beads:changes", item.event, { projectId: item.projectId, source: item.source, ...item.data }, item.version);
  }

  private async readSnapshot(project: BeadsProject): Promise<Snapshot> {
    const issues = await this.readIssues(project);
    return { issues, deps: issues.flatMap((issue) => issue.dependencies), memories: await this.readMemories(project), kv: [] };
  }

  private async readIssues(project: BeadsProject): Promise<BeadIssue[]> {
    const client = project.doltPort ? new DoltClient({ host: "127.0.0.1", port: project.doltPort, database: project.doltDatabase }) : null;
    if (client && !client.isBreakerOpen()) {
      try {
        return await client.getIssues({ limit: 1000 });
      } catch {
        // fall through to JSONL
      }
    }
    try { return (await Bun.file(join(project.beadsPath, "issues.jsonl")).text()).split("\n").flatMap((line) => BeadsReader.parseIssueLine(line)).map((issue) => ({ ...issue, project_id: project.id })); } catch { return []; }
  }

  private async readMemories(project: BeadsProject): Promise<Memory[]> {
    try { return (await Bun.file(join(project.beadsPath, "knowledge.jsonl")).text()).split("\n").flatMap((line) => BeadsReader.parseMemoryLine(line)).map((memory) => ({ ...memory, project_id: project.id })); } catch { return []; }
  }

  private async getCommitHash(project: BeadsProject): Promise<string | null> {
    if (!project.doltPort) return null;
    // forge-h830: previous version created a fresh DoltClient per poll and never
    // disconnected → connection leak + bypassed breaker. Now (1) checks breaker
    // before connecting so we don't pile pressure on an already-failing Dolt,
    // and (2) disconnects in a finally so each poll closes its own connection.
    const client = new DoltClient({ host: "127.0.0.1", port: project.doltPort, database: project.doltDatabase });
    if (client.isBreakerOpen()) return null;
    try {
      await client.connect();
      return await client.getCommitHash();
    } catch {
      return null;
    } finally {
      try { await client.disconnect(); } catch { /* best-effort close */ }
    }
  }

}


function uniqueProjectIds(events: PendingEvent[]): string[] {
  return [...new Set(events.map((event) => event.projectId))];
}

function countEvents(events: PendingEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1;
  return counts;
}

function summarizeIssueEvents(events: PendingEvent[]): Array<Record<string, unknown>> {
  const issueEvents = events
    .map((event) => {
      const issue = event.data.issue as BeadIssue | undefined;
      const issueId = issue?.id ?? event.data.issueId ?? event.data.id;
      if (!issueId) return null;
      return {
        event: event.event,
        projectId: event.projectId,
        issueId: String(issueId),
        status: issue?.status,
        title: issue?.title ? truncate(issue.title, 120) : undefined,
        created_at: issue?.created_at,
        updated_at: issue?.updated_at,
        version: event.version,
      };
    })
    .filter((event): event is Record<string, unknown> => Boolean(event));
  return issueEvents.slice(0, 50);
}

function summarizeIssue(issue: BeadIssue): Record<string, unknown> {
  return {
    id: issue.id,
    title: truncate(issue.title, 120),
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner ?? null,
    assignee: issue.assignee ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function newestIssueSummary(issues: BeadIssue[]): Record<string, unknown> | null {
  const newest = [...issues].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return newest ? summarizeIssue(newest) : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
