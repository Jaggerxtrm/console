import type { Database } from "bun:sqlite";
import type { ChannelRegistry } from "../../api/ws/channels.ts";
import { BeadsChangeWatcher } from "../../core/beads-change-watcher.ts";
import { ProjectScanner } from "../../core/project-scanner.ts";
import { BeadsAdapter } from "../../core/materializer/beads-adapter.ts";
import type { Materializer } from "../../core/materializer/index.ts";

export class TriggerWatcher {
  private readonly watcher: BeadsChangeWatcher;
  private readonly registered = new Set<string>();

  constructor(
    private readonly materializer: Materializer,
    private readonly xtrmDb: Database,
    registry: ChannelRegistry,
    private readonly scanner = new ProjectScanner({ searchPath: process.env.XDG_PROJECTS_DIR || "/home" }),
  ) {
    this.watcher = new BeadsChangeWatcher({
      registry,
      scanner,
      triggerMaterializer: (project) => this.registerAndTrigger(project.id, project.beadsPath, project.doltPort, project.doltDatabase),
    });
  }

  start(): void {
    void this.registerDiscoveredSources();
    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  private async registerDiscoveredSources(): Promise<void> {
    const projects = await this.scanner.scanAll();
    for (const project of projects) this.registerAndTrigger(project.id, project.beadsPath, project.doltPort, project.doltDatabase, false);
  }

  private registerAndTrigger(projectId: string, beadsPath: string, doltPort?: number, doltDatabase?: string, enqueue = true): void {
    const sourceKey = `beads:${projectId}`;
    if (!this.registered.has(sourceKey)) {
      this.xtrmDb.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, 'beads', ?, 'discovered', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET path=excluded.path, status=excluded.status, last_seen_at=excluded.last_seen_at").run(sourceKey, beadsPath);
      this.materializer.register(sourceKey, new BeadsAdapter({ sourceKey, projectId, beadsPath, xtrmDb: this.xtrmDb, doltPort, doltDatabase }));
      this.registered.add(sourceKey);
    }
    if (enqueue) this.materializer.trigger(sourceKey);
  }
}
