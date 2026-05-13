/**
 * Project Scanner - Discovers beads projects on the filesystem
 */

import { lstat, readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import type { BeadsProject, ProjectSourceHealth, ProjectSourceKind } from "../types/beads.ts";

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

const SOURCE_PRIORITY: ProjectSourceKind[] = ["dolt", "sqlite", "jsonl", "unknown"];

export class ProjectScanner {
  private config: ProjectScannerConfig;
  private projectCache: Map<string, BeadsProject> = new Map();

  constructor(config: Partial<ProjectScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async scanAll(): Promise<BeadsProject[]> {
    const projects: BeadsProject[] = [];
    const pathsToScan = this.config.scanPaths?.length
      ? this.config.scanPaths
      : this.config.searchPath
        ? [this.config.searchPath]
        : [];

    for (const scanPath of pathsToScan) {
      const found = await this.scanPath(scanPath, 0);
      projects.push(...found);
    }

    for (const project of projects) {
      this.projectCache.set(project.id, project);
    }

    return projects;
  }

  async scanDirectory(): Promise<BeadsProject[]> {
    return this.scanAll();
  }

  private async scanPath(dirPath: string, depth: number): Promise<BeadsProject[]> {
    if (depth > this.config.maxDepth) return [];

    const projects: BeadsProject[] = [];

    try {
      if (this.isWorktreePath(dirPath)) return [];

      const entries = await readdir(dirPath, { withFileTypes: true });
      if (depth === 0) {
        const candidates = entries
          .filter((entry) => entry.isDirectory())
          .filter((entry) => !this.config.excludePatterns.includes(entry.name))
          .filter((entry) => entry.name !== ".worktrees" && entry.name !== "worktrees")
          .map((entry) => this.withTimeout(this.loadProject(join(dirPath, entry.name)), 250, null));
        const loaded = await Promise.all(candidates);
        return loaded.filter((project): project is BeadsProject => Boolean(project));
      }

      const beadsDir = entries.find((entry) => entry.name === ".beads" && entry.isDirectory());
      if (beadsDir && depth > 0) {
        const project = await this.loadProject(dirPath);
        return project ? [project] : [];
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.config.excludePatterns.includes(entry.name)) continue;
        if (entry.name === ".worktrees" || entry.name === "worktrees") continue;

        const subPath = join(dirPath, entry.name);
        const subProjects = await this.withTimeout(this.scanPath(subPath, depth + 1), 500, []);
        projects.push(...subProjects);
      }
    } catch {
      // unreadable directory
    }

    return projects;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  private isWorktreePath(dirPath: string): boolean {
    return dirPath.split(/[\\/]+/).some((part) => part === ".worktrees" || part === "worktrees");
  }

  private async isGitWorktree(repoPath: string): Promise<boolean> {
    try {
      const gitPath = join(repoPath, ".git");
      const stat = await lstat(gitPath);
      if (!stat.isFile()) return false;
      const gitFile = await readFile(gitPath, "utf-8");
      return gitFile.trim().startsWith("gitdir:");
    } catch {
      return false;
    }
  }

  private async loadProject(repoPath: string): Promise<BeadsProject | null> {
    const beadsPath = join(repoPath, ".beads");

    try {
      if (await this.isGitWorktree(repoPath)) return null;

      const metadataPath = join(beadsPath, "metadata.json");
      const metadataContent = await readFile(metadataPath, "utf-8");
      const metadata = JSON.parse(metadataContent) as { project_id?: string; issue_count?: number };

      const configPath = join(beadsPath, "config.yaml");
      let doltPort: number | undefined;
      let doltDatabase: string | undefined;

      try {
        const configContent = await readFile(configPath, "utf-8");
        const portMatch = configContent.match(/port:\s*(\d+)/);
        if (portMatch) doltPort = Number.parseInt(portMatch[1], 10);

        const dbMatch = configContent.match(/dolt_database:\s*(\S+)/);
        if (dbMatch) doltDatabase = dbMatch[1];
      } catch {
        // no config
      }

      const sourceHealth = await this.detectSourceHealth(beadsPath, doltPort);
      const source = sourceHealth.find((entry) => entry.state === "available")?.kind ?? "unknown";

      return {
        id: metadata.project_id || basename(repoPath),
        name: basename(repoPath),
        path: repoPath,
        beadsPath,
        doltPort,
        doltDatabase,
        source,
        sourceHealth,
        sourcePriority: SOURCE_PRIORITY,
        status: source === "unknown" ? "idle" : "active",
        lastScanned: new Date().toISOString(),
        issueCount: typeof metadata.issue_count === "number" ? metadata.issue_count : 0,
      };
    } catch {
      return null;
    }
  }

  private async detectSourceHealth(beadsPath: string, doltPort?: number): Promise<ProjectSourceHealth[]> {
    const candidates: ProjectSourceHealth[] = [];
    candidates.push({
      kind: "dolt",
      state: doltPort ? "available" : "missing",
      detail: doltPort ? `port ${doltPort}` : "no dolt port configured",
    });

    const fileNames = await this.listBeadsFiles(beadsPath);
    const sqliteFile = fileNames.find((file) => /\.(db|sqlite|sqlite3)$/i.test(file));
    candidates.push({
      kind: "sqlite",
      state: sqliteFile ? "available" : "missing",
      path: sqliteFile ? join(beadsPath, sqliteFile) : undefined,
    });

    const jsonlFile = fileNames.find((file) => file === "issues.jsonl" || file === "issue-log.jsonl");
    candidates.push({
      kind: "jsonl",
      state: jsonlFile ? "available" : "missing",
      path: jsonlFile ? join(beadsPath, jsonlFile) : undefined,
    });

    return candidates;
  }

  private async listBeadsFiles(beadsPath: string): Promise<string[]> {
    try {
      const entries = await readdir(beadsPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  getProject(id: string): BeadsProject | undefined {
    return this.projectCache.get(id);
  }

  getCachedProjects(): BeadsProject[] {
    return Array.from(this.projectCache.values());
  }
}
