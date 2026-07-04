import { join } from "node:path";
import type { ChannelRegistry } from "../api/ws/channels.ts";
import type { BeadDependency, BeadIssue, BeadsProject, Memory } from "../types/beads.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { DoltClient } from "./dolt-client.ts";
import { BeadsReader } from "./beads-reader.ts";
import { emit } from "./logger.ts";
import { BeadsWatcherRuntime, type BeadsWatcherSnapshot } from "../../../../packages/core/src/runtime/beads-watcher.ts";

type OptionalDoltHealth = { isBreakerOpen?: () => boolean; getCommitHash?: () => Promise<string | null> };

/**
 * Compatibility adapter over the core {@link BeadsWatcherRuntime}. The host app
 * owns project discovery (ProjectScanner), snapshot reads (DoltClient + JSONL
 * fallback), commit-hash reads, realtime publishing, and the materializer
 * trigger control; the loop/diff/queue/flush policy and commit-hash parity
 * fast-path live in core. Constructor/start/stop signatures are preserved so
 * TriggerWatcher and server wiring need no changes.
 */
export class BeadsChangeWatcher {
  private readonly runtime: BeadsWatcherRuntime<BeadsProject>;

  constructor(private readonly options: { scanner?: ProjectScanner; registry: ChannelRegistry; triggerMaterializer?: (project: BeadsProject) => void }) {
    const scanner = options.scanner ?? new ProjectScanner({ searchPath: process.env.XDG_PROJECTS_DIR || "/home" });
    this.runtime = new BeadsWatcherRuntime<BeadsProject>({
      scanProjects: () => scanner.scanAll(),
      readSnapshot: (project) => this.readSnapshot(project),
      readCommitHash: (project) => this.getCommitHash(project),
      publish: (channel, event, data, version) => options.registry.publish(channel, event, data, version),
      emitLog: (entry) => emit(entry),
      triggerMaterializer: options.triggerMaterializer,
    });
  }

  start(): void { this.runtime.start(); }
  stop(): void { this.runtime.stop(); }

  private async readSnapshot(project: BeadsProject): Promise<BeadsWatcherSnapshot> {
    const issues = await this.readIssues(project);
    return { issues, deps: issues.flatMap((issue) => issue.dependencies), memories: await this.readMemories(project), kv: [] };
  }

  private async readIssues(project: BeadsProject): Promise<BeadIssue[]> {
    const client = project.doltPort ? new DoltClient({ host: "127.0.0.1", port: project.doltPort, database: project.doltDatabase }) : null;
    if (client && !((client as OptionalDoltHealth).isBreakerOpen?.() ?? false)) {
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
    if ((client as OptionalDoltHealth).isBreakerOpen?.() ?? false) return null;
    try {
      await client.connect();
      return await ((client as OptionalDoltHealth).getCommitHash?.() ?? Promise.resolve(null));
    } catch {
      return null;
    } finally {
      try { await client.disconnect(); } catch { /* best-effort close */ }
    }
  }
}
