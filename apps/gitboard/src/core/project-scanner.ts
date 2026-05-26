/**
 * Project Scanner - Discovers beads projects on the filesystem
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, basename } from "path";
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
  private config: ProjectScannerConfig;
  private projectCache: Map<string, BeadsProject> = new Map();
  private nameToId: Map<string, string> = new Map();

  constructor(config: Partial<ProjectScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan all configured paths for beads projects
   */
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

    // Update cache
    for (const project of projects) {
      this.projectCache.set(project.id, project);
      this.nameToId.set(project.name, project.id);
    }

    return projects;
  }

  /**
   * Scan for projects - main entry point
   */
  async scanDirectory(): Promise<BeadsProject[]> {
    return this.scanAll();
  }

  /**
   * Scan a single directory for .beads/ folders
   */
  private async scanPath(dirPath: string, depth: number): Promise<BeadsProject[]> {
    if (depth > this.config.maxDepth) return [];

    const projects: BeadsProject[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      // Check if this directory has .beads/
      const beadsDir = entries.find(e => e.name === ".beads" && e.isDirectory());
      if (beadsDir) {
        const project = await this.loadProject(dirPath);
        if (project) projects.push(project);
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this.config.excludePatterns.includes(entry.name)) continue;

        const subPath = join(dirPath, entry.name);
        const subProjects = await this.scanPath(subPath, depth + 1);
        projects.push(...subProjects);
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return projects;
  }

  /**
   * Load project metadata from .beads/ directory
   */
  private async loadProject(repoPath: string): Promise<BeadsProject | null> {
    const beadsPath = join(repoPath, ".beads");

    try {
      const metadataPath = join(beadsPath, "metadata.json");
      const metadataContent = await readFile(metadataPath, "utf-8");
      const metadata = JSON.parse(metadataContent);

      // Read config.yaml for dolt settings
      const configPath = join(beadsPath, "config.yaml");
      let doltPort: number | undefined;
      let doltDatabase: string | undefined;

      try {
        const configContent = await readFile(configPath, "utf-8");
        const sharedServerEnabled = /dolt\.shared-server:\s*true|shared-server:\s*true/.test(configContent);
        const portMatch = configContent.match(/port:\s*(\d+)/);
        if (portMatch && !sharedServerEnabled) doltPort = parseInt(portMatch[1]);

        const dbMatch = configContent.match(/dolt_database:\s*(\S+)/);
        if (dbMatch) doltDatabase = dbMatch[1];

        if (sharedServerEnabled && process.env.HOME) {
          const sharedPortPath = join(process.env.HOME, ".beads/shared-server/dolt-server.port");
          try {
            const sharedPortContent = await readFile(sharedPortPath, "utf-8");
            const sharedPort = parseInt(sharedPortContent.trim());
            if (!Number.isNaN(sharedPort)) doltPort = sharedPort;
          } catch {
            // shared-server port file missing — fall through
          }
        }
        if (!doltDatabase && metadata.dolt_database) doltDatabase = metadata.dolt_database;
      } catch {
        // No config.yaml
      }

      const project: BeadsProject = {
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

      return project;
    } catch {
      return null;
    }
  }

  /**
   * Get cached project by ID or name
   */
  getProject(idOrName: string): BeadsProject | undefined {
    // Try by ID first
    let project = this.projectCache.get(idOrName);
    if (project) return project;

    // Try by name
    const id = this.nameToId.get(idOrName);
    if (id) return this.projectCache.get(id);

    return undefined;
  }

  /**
   * Get all cached projects
   */
  getCachedProjects(): BeadsProject[] {
    return Array.from(this.projectCache.values());
  }
}