import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { makeLogEntry, type LogEntry, type LogLevel } from "./logs.ts";
import {
  buildBeadsSourceHealthEvent,
  buildSourceHealthChangedPayload,
  decideBeadsSourceRead,
} from "./source-lifecycle-policy.ts";

// forge-h830: the 2s interval was hammering Dolt with getCommitHash + readSnapshot
// for every tracked project (25 × every 2s = 12 qps just for this watcher),
// causing slow-query / circuit-breaker cascades on the shared 3308 server and
// generating ~50 WS batches/sec of mostly redundant events. fs.watch on each
// project's issues.jsonl (see ensureWatcher) already provides ~1s-latency real-
// time signal for actual changes; the interval is just a backup heartbeat and
// can run much less often without hurting user-visible freshness.
export const BEADS_WATCHER_ACTIVE_POLL_MS = 30_000;
export const BEADS_WATCHER_IDLE_POLL_MS = 60_000;
export const BEADS_WATCHER_DEBOUNCE_MS = 1_000;
export const BEADS_WATCHER_COALESCE_MS = 1_500;
export const BEADS_WATCHER_MAX_BATCH = 50;

export interface BeadsWatcherProject {
  id: string;
  beadsPath: string;
  doltPort?: number;
  doltDatabase?: string;
}

export interface BeadsWatcherDependency {
  id: string;
}

export interface BeadsWatcherIssue {
  id: string;
  title: string;
  status: string;
  priority: number | string;
  issue_type?: string;
  owner?: string | null;
  created_at: string;
  updated_at?: string;
  labels?: unknown[];
  parent_id?: string | null;
  dependencies?: BeadsWatcherDependency[];
}

export interface BeadsWatcherMemory {
  id: string;
}

export interface BeadsWatcherKvEntry {
  key: string;
  value: unknown;
  project_id: string;
}

export interface BeadsWatcherSnapshot {
  issues: BeadsWatcherIssue[];
  deps: BeadsWatcherDependency[];
  memories: BeadsWatcherMemory[];
  kv: BeadsWatcherKvEntry[];
}

export type BeadsWatcherEventSource = "dolt" | "jsonl" | "sqlite";

export interface BeadsWatcherPendingEvent {
  projectId: string;
  source: BeadsWatcherEventSource;
  version: string;
  event: string;
  data: Record<string, unknown>;
}

export interface BeadsWatcherPublisher {
  publish(channel: "substrate:changes", event: string, data: unknown, version?: string): unknown;
}

/**
 * Ports the host app supplies. Core owns loop/diff/queue/flush policy and the
 * commit-hash fast-path; the app owns project discovery, snapshot reads, the
 * materializer trigger control, and realtime/log publishing.
 */
export interface BeadsWatcherPorts<TProject extends BeadsWatcherProject = BeadsWatcherProject> {
  scanProjects(): Promise<TProject[]>;
  readSnapshot(project: TProject): Promise<BeadsWatcherSnapshot>;
  readCommitHash(project: TProject): Promise<string | null>;
  publish: BeadsWatcherPublisher["publish"];
  emitLog: (entry: LogEntry) => void;
  /** When present the watcher short-circuits polling into a single trigger call. */
  triggerMaterializer?: (project: TProject) => void;
}

/**
 * Core runtime service for beads change watching. Owns the poll loop, fs.watch
 * debouncing, snapshot diffing, the commit-hash parity fast-path, and the
 * coalesced batch flush. Commit-hash/parity behavior, queue/flush ordering, and
 * materializer trigger semantics are stable here; the host app supplies only
 * discovery, snapshot reads, publishing, and the materializer trigger.
 */
export class BeadsWatcherRuntime<TProject extends BeadsWatcherProject = BeadsWatcherProject> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private watchers = new Map<string, FSWatcher>();
  private previous = new Map<string, BeadsWatcherSnapshot>();
  private lastCommitHash = new Map<string, string>();
  private queue: BeadsWatcherPendingEvent[] = [];
  private lastHealth = new Map<string, boolean>();

  constructor(
    private readonly ports: BeadsWatcherPorts<TProject>,
    private readonly timing: {
      activePollMs?: number;
      idlePollMs?: number;
      debounceMs?: number;
      coalesceMs?: number;
      maxBatch?: number;
    } = {},
  ) {}

  start(): void { void this.loop(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.clearFlushTimer();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  isStopped(): boolean { return this.stopped; }

  getQueueLength(): number { return this.queue.length; }

  private clearFlushTimer(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  private get activePollMs(): number { return this.timing.activePollMs ?? BEADS_WATCHER_ACTIVE_POLL_MS; }
  private get idlePollMs(): number { return this.timing.idlePollMs ?? BEADS_WATCHER_IDLE_POLL_MS; }
  private get debounceMs(): number { return this.timing.debounceMs ?? BEADS_WATCHER_DEBOUNCE_MS; }
  private get coalesceMs(): number { return this.timing.coalesceMs ?? BEADS_WATCHER_COALESCE_MS; }
  private get maxBatch(): number { return this.timing.maxBatch ?? BEADS_WATCHER_MAX_BATCH; }

  private log(event: string, level: LogLevel, msg: string | undefined, data: Record<string, unknown>): void {
    this.ports.emitLog(makeLogEntry("watcher", event, level, msg, data));
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const projects = await this.ports.scanProjects();
    if (this.stopped) return;
    for (const project of projects) {
      if (this.stopped) return;
      this.ensureWatcher(project);
      await this.poll(project);
      if (this.stopped) return;
    }
    this.timer = setTimeout(() => void this.loop(), projects.length > 0 ? this.activePollMs : this.idlePollMs);
    this.timer.unref?.();
  }

  private ensureWatcher(project: TProject): void {
    if (this.watchers.has(project.id)) return;
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const watcher = watch(join(project.beadsPath, "issues.jsonl"), { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void this.poll(project), this.debounceMs);
      });
      this.watchers.set(project.id, watcher);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") console.error("[beads-change-watcher] watch failed", project.id, error);
    }
  }

  private async poll(project: TProject): Promise<void> {
    if (this.stopped) return;
    if (this.ports.triggerMaterializer) {
      this.ports.triggerMaterializer(project);
      return;
    }
    const commitHash = await this.ports.readCommitHash(project);
    if (this.stopped) return;
    const prevHash = this.lastCommitHash.get(project.id);
    const haveSnapshot = this.previous.has(project.id);
    const readiness = decideBeadsSourceRead(commitHash, prevHash ?? null, haveSnapshot);

    // Fast path: commit hash unchanged AND we already have a snapshot →
    // nothing diffed since last tick. Emit health and skip the expensive
    // readSnapshot (which would otherwise SELECT up to 1000 rows + 3 batched
    // IN-clause hydration queries per project per 2s on a stable repo).
    if (readiness.shouldSkipRead && commitHash) {
      this.log("poll.skipped", "debug", undefined, { projectId: project.id });
      this.enqueue({
        projectId: project.id,
        source: readiness.source,
        version: commitHash,
        event: "beads:source_health",
        data: buildBeadsSourceHealthEvent(project.id, commitHash, false, true),
      });
      return;
    }

    this.log("poll.snapshot_read", "info", undefined, { projectId: project.id });
    const snapshotStartedAt = performance.now();
    const snapshot = await this.ports.readSnapshot(project);
    if (this.stopped) return;
    const previous = this.previous.get(project.id);
    const drift = Boolean(previous && previous.issues.length !== snapshot.issues.length);
    this.log("poll.snapshot_result", "info", undefined, {
      projectId: project.id,
      source: commitHash ? "dolt" : "jsonl",
      version: commitHash ?? null,
      ms: Math.round(performance.now() - snapshotStartedAt),
      issues: snapshot.issues.length,
      deps: snapshot.deps.length,
      memories: snapshot.memories.length,
      drift,
      initial: !previous,
    });
    this.previous.set(project.id, snapshot);
    if (commitHash) this.lastCommitHash.set(project.id, commitHash);
    const healthy = Boolean(commitHash);
    const priorHealthy = this.lastHealth.get(project.id);
    if (priorHealthy !== healthy) {
      this.lastHealth.set(project.id, healthy);
      this.log("source_health.changed", "info", undefined, buildSourceHealthChangedPayload(project.id, healthy, commitHash ? "dolt" : "jsonl"));
    }
    // forge-h830: the cached commit hash MUST persist across stable-state polls
    // for the fast-path check above to work. A delete here would actively defeat
    // that optimization — every poll for a healthy project would then refetch
    // the full snapshot (1000 rows + 3 hydration queries), diff it (producing
    // ~50 upsert events that overflow the batch), and flush ~60 publishes/sec to
    // WS subscribers. Keep the cached hash so "skip readSnapshot when commit hash
    // unchanged" semantics hold.
    if (drift) this.log("drift.detected", "warn", undefined, { projectId: project.id });
    this.enqueue({ projectId: project.id, source: commitHash ? "dolt" : "jsonl", version: commitHash ?? String(Date.now()), event: "beads:source_health", data: buildBeadsSourceHealthEvent(project.id, commitHash, drift, healthy) });
    this.diffAndQueue(project.id, previous, snapshot, commitHash ?? String(Date.now()));
  }

  private diffAndQueue(projectId: string, previous: BeadsWatcherSnapshot | undefined, next: BeadsWatcherSnapshot, version: string): void {
    const prevIssues = new Map(previous?.issues.map((issue) => [issue.id, issue]) ?? []);
    const nextIssues = new Map(next.issues.map((issue) => [issue.id, issue]));
    if (!previous) {
      this.log("beads.snapshot.initialized", "info", undefined, {
        projectId,
        version,
        issues: next.issues.length,
        newestIssue: newestIssueSummary(next.issues),
      });
    }
    for (const issue of next.issues) {
      const before = prevIssues.get(issue.id);
      if (previous && !before) {
        this.log("beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "created",
          issue: summarizeIssue(issue),
        });
      } else if (before && before.status !== issue.status) {
        this.log("beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "status",
          issue: summarizeIssue(issue),
          previousStatus: before.status,
        });
      } else if (before && before.updated_at !== issue.updated_at) {
        this.log("beads.issue.detected", "info", undefined, {
          projectId,
          version,
          change: "updated",
          issue: summarizeIssue(issue),
          previousUpdatedAt: before.updated_at,
        });
      }
      this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.upsert", data: { issue } });
      if (before?.status !== "closed" && issue.status === "closed") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.close", data: { issueId: issue.id } });
      if (!before && issue.status === "closed") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.close", data: { issueId: issue.id } });
      if (!before?.labels?.length && issue.labels && issue.labels.length > 0) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.flagged", data: { issue } });
      if (before?.labels?.length && (!issue.labels || issue.labels.length === 0)) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.unflagged", data: { issue } });
      if (before?.parent_id == null && issue.parent_id != null) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.superseded", data: { issue } });
      if (before?.status !== "deferred" && issue.status === "deferred") this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.deferred", data: { issue } });
    }
    for (const issue of previous?.issues ?? []) if (!nextIssues.has(issue.id)) this.enqueue({ projectId, source: "dolt", version, event: "beads:issue.delete", data: { issueId: issue.id } });
    this.diffList(projectId, previous?.deps ?? [], next.deps, version, "beads:dep.upsert", "beads:dep.delete", "id");
    this.diffList(projectId, previous?.memories ?? [], next.memories, version, "beads:memory.upsert", "beads:memory.delete", "id");
    this.diffList(projectId, previous?.kv ?? [], next.kv, version, "beads:kv.upsert", "beads:kv.delete", "key");
  }

  private diffList<T>(projectId: string, previous: T[], next: T[], version: string, upsertEvent: string, deleteEvent: string, key: keyof T & string): void {
    const nextIds = new Set(next.map((item) => String(item[key])));
    for (const item of next) this.enqueue({ projectId, source: "dolt", version, event: upsertEvent, data: { [key]: item[key], ...item } as Record<string, unknown> });
    for (const item of previous) if (!nextIds.has(String(item[key]))) this.enqueue({ projectId, source: "dolt", version, event: deleteEvent, data: { [key]: item[key] } as Record<string, unknown> });
  }

  private enqueue(event: BeadsWatcherPendingEvent): void {
    this.queue.push(event);
    if (this.stopped) return;
    if (this.queue.length >= this.maxBatch) { this.flush(true); return; }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(false), this.coalesceMs);
      this.flushTimer.unref?.();
    }
  }

  private flush(overflow: boolean): void {
    this.clearFlushTimer();
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    this.log("batch.published", "info", undefined, {
      count: batch.length,
      overflow: overflow || batch.length > this.maxBatch,
      projectIds: uniqueProjectIds(batch),
      eventCounts: countEvents(batch),
      issueEvents: summarizeIssueEvents(batch),
    });
    if (overflow || batch.length > this.maxBatch) {
      this.log("batch.overflow_sync_hint", "warn", undefined, {
        count: batch.length,
        projectIds: uniqueProjectIds(batch),
        eventCounts: countEvents(batch),
        version: batch.at(-1)?.version ?? null,
      });
      this.ports.publish("substrate:changes", "substrate:sync_hint", { reason: "overflow" }, batch.at(-1)?.version);
      return;
    }
    const grouped = new Map<string, BeadsWatcherPendingEvent[]>();
    for (const item of batch) grouped.set(item.projectId, [...(grouped.get(item.projectId) ?? []), item]);
    for (const [projectId, events] of grouped) {
      this.log("beads.batch.project_published", "info", undefined, {
        projectId,
        count: events.length,
        eventCounts: countEvents(events),
        issueEvents: summarizeIssueEvents(events),
        version: events.at(-1)?.version ?? null,
      });
      this.ports.publish("substrate:changes", "beads:batch", { project_id: projectId, issues: events.filter((e) => e.event === "beads:issue.upsert").map((e) => e.data.issue), dependencies: events.filter((e) => e.event === "beads:dep.upsert").map((e) => e.data as unknown as BeadsWatcherDependency), memories: events.filter((e) => e.event === "beads:memory.upsert").map((e) => e.data as unknown as BeadsWatcherMemory), kv: events.filter((e) => e.event === "beads:kv.upsert").map((e) => e.data as unknown as BeadsWatcherKvEntry) }, events.at(-1)?.version);
    }
    for (const item of batch) this.ports.publish("substrate:changes", item.event, { projectId: item.projectId, source: item.source, ...item.data }, item.version);
  }
}

function uniqueProjectIds(events: BeadsWatcherPendingEvent[]): string[] {
  return [...new Set(events.map((event) => event.projectId))];
}

function countEvents(events: BeadsWatcherPendingEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1;
  return counts;
}

function summarizeIssueEvents(events: BeadsWatcherPendingEvent[]): Array<Record<string, unknown>> {
  const issueEvents = events
    .map((event) => {
      const issue = event.data.issue as BeadsWatcherIssue | undefined;
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
    .filter((event): event is {
      event: string;
      projectId: string;
      issueId: string;
      status: string | undefined;
      title: string | undefined;
      created_at: string | undefined;
      updated_at: string | undefined;
      version: string;
    } => Boolean(event));
  return issueEvents.slice(0, 50);
}

function summarizeIssue(issue: BeadsWatcherIssue): Record<string, unknown> {
  return {
    id: issue.id,
    title: truncate(issue.title, 120),
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function newestIssueSummary(issues: BeadsWatcherIssue[]): Record<string, unknown> | null {
  const newest = [...issues].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return newest ? summarizeIssue(newest) : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
