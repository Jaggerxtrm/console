import { basename, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { BeadsProject } from "../types/beads.ts";

export interface ProjectScannerConfig {
  searchPath?: string;
  scanPaths?: string[];
  excludePatterns: string[];
  maxDepth: number;
}

const DEFAULT_CONFIG: ProjectScannerConfig = {
  scanPaths: [],
  excludePatterns: ["node_modules", ".git", "dist", "build"],
  maxDepth: 3,
};

export class ProjectScanner {
  private readonly config: ProjectScannerConfig;
  private readonly projectCache = new Map<string, BeadsProject>();
  private readonly nameToId = new Map<string, string>();
  private scanInFlight: Promise<BeadsProject[]> | null = null;

  constructor(config: Partial<ProjectScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  scanAll(): Promise<BeadsProject[]> {
    if (this.scanInFlight) return this.scanInFlight;
    const scan = this.runScan();
    this.scanInFlight = scan.finally(() => {
      this.scanInFlight = null;
    });
    return this.scanInFlight;
  }

  scanDirectory(): Promise<BeadsProject[]> {
    return this.scanAll();
  }

  getProject(idOrName: string): BeadsProject | undefined {
    const direct = this.projectCache.get(idOrName);
    if (direct) return direct;
    const id = this.nameToId.get(idOrName);
    return id ? this.projectCache.get(id) : undefined;
  }

  getCachedProjects(): BeadsProject[] {
    return [...this.projectCache.values()];
  }

  private async runScan(): Promise<BeadsProject[]> {
    const projects: BeadsProject[] = [];
    const roots = this.config.scanPaths?.length
      ? this.config.scanPaths
      : this.config.searchPath
        ? [this.config.searchPath]
        : [];
    for (const root of roots) projects.push(...await this.scanPath(root, 0));
    for (const project of projects) {
      this.projectCache.set(project.id, project);
      this.nameToId.set(project.name, project.id);
    }
    return projects;
  }

  private async scanPath(dirPath: string, depth: number): Promise<BeadsProject[]> {
    if (depth > this.config.maxDepth) return [];
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const projects: BeadsProject[] = [];
      if (entries.some((entry) => entry.name === ".beads" && entry.isDirectory())) {
        const project = await this.loadProject(dirPath);
        if (project) projects.push(project);
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || this.shouldSkip(entry.name)) continue;
        projects.push(...await this.scanPath(join(dirPath, entry.name), depth + 1));
      }
      return projects;
    } catch {
      return [];
    }
  }

  private async loadProject(repoPath: string): Promise<BeadsProject | null> {
    const beadsPath = join(repoPath, ".beads");
    try {
      const metadata = JSON.parse(await readFile(join(beadsPath, "metadata.json"), "utf-8")) as {
        project_id?: string;
        dolt_database?: string;
      };
      let doltPort: number | undefined;
      let doltDatabase: string | undefined;
      try {
        const config = await readFile(join(beadsPath, "config.yaml"), "utf-8");
        const shared = /dolt\.shared-server:\s*true|shared-server:\s*true/.test(config);
        const port = config.match(/port:\s*(\d+)/);
        if (port && !shared) doltPort = Number(port[1]);
        doltDatabase = config.match(/dolt_database:\s*(\S+)/)?.[1];
        if (shared && process.env.HOME) {
          try {
            const sharedPort = Number((await readFile(join(process.env.HOME, ".beads/shared-server/dolt-server.port"), "utf-8")).trim());
            if (!Number.isNaN(sharedPort)) doltPort = sharedPort;
          } catch {
            // Missing shared-server port keeps the source in JSONL fallback.
          }
        }
      } catch {
        // config.yaml is optional.
      }
      doltDatabase ??= metadata.dolt_database;
      return {
        id: metadata.project_id || basename(repoPath),
        name: basename(repoPath),
        path: repoPath,
        beadsPath,
        doltPort,
        doltDatabase,
        status: doltPort ? "active" : "idle",
        lastScanned: new Date().toISOString(),
        issueCount: 0,
      };
    } catch {
      return null;
    }
  }

  private shouldSkip(name: string): boolean {
    return name.startsWith(".") || this.config.excludePatterns.includes(name);
  }
}
