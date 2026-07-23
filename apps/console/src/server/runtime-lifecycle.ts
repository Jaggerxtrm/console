import type { Database } from "bun:sqlite";
import { BeadsAdapter } from "../../../../packages/core/src/materializer/beads-adapter.ts";
import { Materializer, type MaterializerRealtimePublisher } from "../../../../packages/core/src/materializer/materializer.ts";
import { createObservabilityAdapter } from "../../../../packages/core/src/materializer/observability-adapter.ts";
import { bump, onBump } from "../../../../packages/core/src/observability/epoch.ts";
import { createObservabilityParityHarness } from "../../../../packages/core/src/observability/parity.ts";
import { listRepos, type RepoEntry } from "../../../../packages/core/src/observability/registry.ts";
import { createObservabilityWatcher } from "../../../../packages/core/src/observability/watcher.ts";
import { createBeadsParityHarness } from "../../../../packages/core/src/runtime/beads-parity.ts";
import { BeadsWatcherRuntime } from "../../../../packages/core/src/runtime/beads-watcher.ts";
import { makeLogEntry } from "../../../../packages/core/src/runtime/logs.ts";
import { ProjectScanner } from "../../../../packages/core/src/runtime/project-scanner.ts";
import { UnifiedScanner } from "../../../../packages/core/src/runtime/unified-scanner.ts";
import { readBeadsIssuesFromJsonl } from "../../../../packages/core/src/state/beads-jsonl-reader.ts";
import { DoltClient } from "../../../../packages/core/src/state/dolt-client.ts";
import type { BeadIssue, BeadsProject } from "../../../../packages/core/src/types/beads.ts";
import type { HostLogger } from "./log.ts";

export interface ConsoleRuntimeOptions {
  db: Database;
  logger: HostLogger;
  beadsSearchPath?: string;
  beadsScanPaths?: string[];
  observabilityRoots?: string[];
  parityEnabled?: boolean;
  startupMaterialize?: boolean;
  publisher?: MaterializerRealtimePublisher;
  observabilityRepos?: readonly RepoEntry[];
}

export interface ConsoleRuntime {
  readonly scanner: UnifiedScanner;
  readonly materializer: Materializer;
  readonly observabilityParityHarness: ReturnType<typeof createObservabilityParityHarness>;
  readonly beadsParityHarness: ReturnType<typeof createBeadsParityHarness>;
  start(): Promise<void>;
  stop(): Promise<void>;
  triggerMaterialization(projectId?: string | null): void;
}

export function createConsoleRuntime(options: ConsoleRuntimeOptions): ConsoleRuntime {
  const owner = "apps/console";
  const parityEnabled = options.parityEnabled
    ?? (process.env.XTRM_ENABLE_PARITY === "1" || process.env.GITBOARD_ENABLE_PARITY === "1");
  const startupMaterialize = options.startupMaterialize
    ?? (process.env.XTRM_STARTUP_MATERIALIZE === "1" || process.env.GITBOARD_STARTUP_MATERIALIZE === "1");
  const telemetryContext = { owner } as const;
  const emitMaterializerLog = (entry: { component: "system" | "ws"; event: string; level: "debug" | "info" | "warn" | "error"; message?: string; data?: Record<string, unknown> }): void => {
    options.logger.emit(makeLogEntry(entry.component, entry.event, entry.level, entry.message, entry.data));
  };
  const materializer = new Materializer(options.db, options.publisher, {
    serviceName: "console",
    telemetryContext,
    emitLog: emitMaterializerLog,
    bumpObservabilityEpoch: bump,
  });
  const scanner = new UnifiedScanner(options.db, {
    owner,
    beadsSearchPath: options.beadsSearchPath,
    beadsScanPaths: options.beadsScanPaths,
    observabilityRoots: options.observabilityRoots,
    parityEnabled,
    emitLog: options.logger.emit,
  });
  const projectScanner = new ProjectScanner({
    searchPath: options.beadsSearchPath ?? process.env.XDG_PROJECTS_DIR ?? (process.env.HOME ? `${process.env.HOME}/projects` : "/home"),
    scanPaths: options.beadsScanPaths,
    maxDepth: 3,
    excludePatterns: ["node_modules", ".git", "dist", "build", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"],
  });
  const observabilityRepos = [...(options.observabilityRepos
    ?? (options.observabilityRoots ? listRepos(() => ({ roots: options.observabilityRoots ?? [] })) : listRepos()))];
  const registered = new Set<string>();
  const watcher = new BeadsWatcherRuntime<BeadsProject>({
    scanProjects: () => projectScanner.scanAll(),
    readSnapshot: async () => ({ issues: [], deps: [], memories: [], kv: [] }),
    readCommitHash: async () => null,
    publish: (channel, event, data, version) => options.publisher?.publish(channel, event, data as Record<string, unknown>, version ?? String(Date.now())),
    emitLog: options.logger.emit,
    telemetryContext,
    triggerMaterializer: (project) => registerAndTrigger(project, true),
  });
  const observabilityWatcher = createObservabilityWatcher(observabilityRepos, {
    emitLog: options.logger.emit,
    telemetryContext,
    logger: { warn: () => {}, debug: () => {} },
    triggerMaterializer: (sourceKey) => {
      materializer.trigger(sourceKey);
    },
  });
  const observabilityParityHarness = createObservabilityParityHarness(options.db, {
    enabled: parityEnabled,
    emitLog: options.logger.emit,
  });
  const beadsParityHarness = createBeadsParityHarness(options.db, {
    enabled: parityEnabled,
    owner,
    emitLog: options.logger.emit,
    scanner: projectScanner,
  });

  let started = false;
  let unsubscribeEpoch: (() => void) | null = null;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    try {
      options.logger.emit(makeLogEntry("system", "runtime.start", "info", undefined, { owner, outcome: "started" }));
      registerObservabilitySources();
      scanner.start();
      await scanner.refresh();
      for (const project of await projectScanner.scanAll()) registerAndTrigger(project, false);
      unsubscribeEpoch = onBump((repoSlug, epoch) => {
        const sourceKey = `obs:${repoSlug}`;
        options.logger.emit(makeLogEntry("system", "epoch.publish", "info", undefined, { owner, outcome: "published", source_key: sourceKey, epoch }));
        options.publisher?.publish("specialists:activity", "specialists:sync_hint", { source_key: sourceKey, kind: "epoch_bump" }, String(Date.now()));
        options.publisher?.publish(`specialists:repo:${repoSlug}`, "specialists:sync_hint", { source_key: sourceKey, kind: "epoch_bump" }, String(Date.now()));
      });
      watcher.start();
      observabilityWatcher.start();
      if (parityEnabled) observabilityParityHarness.start();
      if (parityEnabled) beadsParityHarness.start();
      if (startupMaterialize) {
        for (const repo of observabilityRepos) materializer.trigger(`obs:${repo.repoSlug}`);
      }
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    const errors: unknown[] = [];
    const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    await cleanup(() => observabilityParityHarness.stop());
    await cleanup(() => beadsParityHarness.stop());
    await cleanup(() => observabilityWatcher.stop());
    await cleanup(() => watcher.stop());
    await cleanup(() => scanner.stop());
    await cleanup(() => materializer.stop());
    await cleanup(() => unsubscribeEpoch?.());
    unsubscribeEpoch = null;
    started = false;
    options.logger.emit(makeLogEntry("system", "runtime.stop", errors.length === 0 ? "info" : "error", undefined, {
      owner,
      outcome: errors.length === 0 ? "stopped" : "error",
      cleanup_errors: errors.length,
    }));
    if (errors.length > 0) throw new AggregateError(errors, "Console runtime cleanup failed");
  }

  function registerObservabilitySources(): void {
    for (const repo of observabilityRepos) {
      const sourceKey = `obs:${repo.repoSlug}`;
      upsertSource(sourceKey, "observability", repo.dbPath);
      materializer.register(sourceKey, createObservabilityAdapter(repo.dbPath, repo.repoSlug));
      registered.add(sourceKey);
      options.logger.emit(makeLogEntry("materializer", "source.register", "info", undefined, { owner, outcome: "registered", source_key: sourceKey }));
    }
  }

  function registerAndTrigger(project: BeadsProject, enqueue: boolean): void {
    const sourceKey = `beads:${project.id}`;
    if (!registered.has(sourceKey)) {
      upsertSource(sourceKey, "beads", project.beadsPath);
      materializer.register(sourceKey, new BeadsAdapter({
        sourceKey,
        projectId: project.id,
        xtrmDb: options.db,
        readSnapshot: () => readIssues(project),
        emitLog: emitMaterializerLog,
      }));
      registered.add(sourceKey);
      options.logger.emit(makeLogEntry("materializer", "source.register", "info", undefined, { owner, outcome: "registered", source_key: sourceKey }));
    }
    if (enqueue) materializer.trigger(sourceKey);
  }

  function upsertSource(sourceKey: string, kind: string, path: string): void {
    options.db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, ?, ?, 'discovered', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET path=excluded.path, status=excluded.status, last_seen_at=excluded.last_seen_at")
      .run(sourceKey, kind, path);
  }

  function triggerMaterialization(projectId?: string | null): void {
    if (!projectId) return;
    const sourceKey = projectId.startsWith("beads:") ? projectId : `beads:${projectId}`;
    if (!registered.has(sourceKey)) {
      options.logger.emit(makeLogEntry("materializer", "materializer.trigger", "warn", undefined, { owner, outcome: "skipped", source_key: sourceKey, reason: "unregistered" }));
      throw new Error(`unknown source: ${sourceKey}`);
    }
    materializer.trigger(sourceKey);
  }

  return { scanner, materializer, observabilityParityHarness, beadsParityHarness, start, stop, triggerMaterialization };
}

async function readIssues(project: BeadsProject): Promise<BeadIssue[]> {
  if (project.doltPort) {
    const client = new DoltClient({
      host: process.env.DOLT_HOST ?? "127.0.0.1",
      port: project.doltPort,
      database: project.doltDatabase ?? "dolt",
    });
    try {
      const issues: BeadIssue[] = [];
      for (let offset = 0; offset < 10_000; offset += 1_000) {
        const page = await client.getIssues({ limit: 1_000, offset });
        issues.push(...page);
        if (page.length < 1_000) return issues;
      }
      return issues;
    } catch {
      // Preserve degraded-readable JSONL fallback.
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
  try {
    return (await readBeadsIssuesFromJsonl(project.beadsPath)).map((issue) => ({ ...issue, project_id: project.id }));
  } catch {
    return [];
  }
}
