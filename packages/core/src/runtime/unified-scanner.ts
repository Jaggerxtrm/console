import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { getObservabilityConfig } from "../observability/config.ts";
import { listRepos } from "../observability/registry.ts";
import { makeLogEntry, type LogEntry } from "./logs.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { SourceRefreshLifecycle } from "./source-refresh-lifecycle.ts";
import { formatSourceDisplayPath, getMissingDiscoveredSourceKeys, normalizeLegacySourceStatus, summarizeSourceRefresh } from "./source-lifecycle-policy.ts";

export type UnifiedSourceKind = "beads" | "observability";
export type UnifiedSourceStatus = "active" | "missing";

export interface UnifiedScannerConfig {
  beadsSearchPath?: string;
  beadsScanPaths?: string[];
  observabilityRoots?: string[];
  refreshIntervalMs?: number;
  parityEnabled?: boolean;
  owner?: string;
  emitLog?: (entry: LogEntry) => void;
  listObservabilityRepos?: () => Array<{ repoSlug: string; dbPath: string }>;
}

export type UnifiedSource = {
  sourceKey: string;
  kind: UnifiedSourceKind;
  path: string;
  status: UnifiedSourceStatus;
};

type SourceRow = { source_key: string; kind: string; path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null };

const DEFAULT_REFRESH_MS = 10 * 60 * 1000;
const BEADS_EXCLUDES = ["node_modules", ".git", "dist", "build", ".worktrees", "worktrees"];
const OBSERVABILITY_DB_PATHS = [".specialists/db/observability.db", ".specialists/observability.db", "observability.db"] as const;

export { normalizeLegacySourceStatus };

export class UnifiedScanner {
  private readonly lifecycle: SourceRefreshLifecycle<UnifiedSource[]>;
  private readonly owner: string | undefined;
  private readonly emitLog: (entry: LogEntry) => void;
  private readonly parityEnabled: boolean;
  private readonly listObservabilityRepos: () => Array<{ repoSlug: string; dbPath: string }>;

  constructor(private readonly db: Database, private readonly config: UnifiedScannerConfig = {}) {
    this.owner = config.owner;
    this.emitLog = config.emitLog ?? (() => {});
    this.parityEnabled = config.parityEnabled
      ?? (process.env.XTRM_ENABLE_PARITY === "1" || process.env.GITBOARD_ENABLE_PARITY === "1");
    this.listObservabilityRepos = config.listObservabilityRepos ?? (() => listRepos());
    this.lifecycle = new SourceRefreshLifecycle({
      refreshIntervalMs: config.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      refresh: () => this.runRefresh(),
    });
  }

  start(): void {
    if (this.lifecycle.isRunning()) return;
    this.log("scanner.start", "info", { outcome: "started" });
    this.lifecycle.start();
  }

  async stop(): Promise<void> {
    const wasRunning = this.lifecycle.isRunning();
    await this.lifecycle.stop();
    if (wasRunning) this.log("scanner.stop", "info", { outcome: "stopped" });
  }

  refresh(): Promise<UnifiedSource[]> {
    return this.lifecycle.refresh();
  }

  async getSources(): Promise<Array<{ source_key: string; kind: string; display_path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null }>> {
    const rows = this.db.query<SourceRow, []>("SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources ORDER BY kind ASC, source_key ASC").all();
    return rows.map((row) => ({
      source_key: row.source_key,
      kind: row.kind,
      display_path: formatSourceDisplayPath(row.path),
      origin: row.origin,
      status: row.status,
      discovered_at: row.discovered_at,
      last_seen_at: row.last_seen_at,
    }));
  }

  private async runRefresh(): Promise<UnifiedSource[]> {
    const startedAt = performance.now();
    this.log("refresh.start", "info", { outcome: "started" });
    try {
      const discovered = await this.scan();
      this.upsertDiscoveredSources(discovered);
      this.markMissingSources(discovered);
      this.log("scanner.refresh", "info", summarizeSourceRefresh(discovered));
      if (this.parityEnabled) await this.emitParityDiff(discovered);
      this.log("refresh.end", "info", {
        outcome: "success",
        duration_ms: Math.round(performance.now() - startedAt),
        discovered: discovered.length,
      });
      return discovered;
    } catch (error) {
      this.log("refresh.end", "error", {
        outcome: "error",
        duration_ms: Math.round(performance.now() - startedAt),
        error_type: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  }

  private async scan(): Promise<UnifiedSource[]> {
    const beads = (await Promise.all(this.getBeadsRoots().map((root) => this.scanBeadsPath(root, 0)))).flat();
    const candidates = this.getObservabilityRoots().flatMap((root) => this.scanObservabilityCandidates(root));
    const observability = this.assignObsSlugs(candidates).map((entry): UnifiedSource => ({
      sourceKey: `obs:${entry.repoSlug}`,
      kind: "observability",
      path: entry.dbPath,
      status: "active",
    }));
    return [...beads, ...observability];
  }

  private getBeadsRoots(): string[] {
    if (this.config.beadsScanPaths?.length) return this.config.beadsScanPaths;
    return [this.config.beadsSearchPath ?? process.env.XDG_PROJECTS_DIR ?? (process.env.HOME ? `${process.env.HOME}/projects` : "/home")];
  }

  private getObservabilityRoots(): string[] {
    return this.config.observabilityRoots?.length ? this.config.observabilityRoots : getObservabilityConfig().roots;
  }

  private async scanBeadsPath(dirPath: string, depth: number): Promise<UnifiedSource[]> {
    if (depth > 3 || this.isWorktreePath(dirPath) || this.isGitWorktree(dirPath)) return [];
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const discovered: UnifiedSource[] = [];
      if (entries.some((entry) => entry.name === ".beads" && entry.isDirectory())) {
        const projectId = await this.getBeadsProjectId(dirPath);
        if (projectId) discovered.push({ sourceKey: `beads:${projectId}`, kind: "beads", path: join(dirPath, ".beads"), status: "active" });
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !this.shouldSkip(entry.name)) discovered.push(...await this.scanBeadsPath(join(dirPath, entry.name), depth + 1));
      }
      return discovered;
    } catch (error) {
      this.logProbeFailure("beads scan", error);
      return [];
    }
  }

  private async getBeadsProjectId(repoPath: string): Promise<string | null> {
    try {
      const metadata = JSON.parse(await readFile(join(repoPath, ".beads", "metadata.json"), "utf-8")) as { project_id?: string };
      return metadata.project_id || basename(repoPath);
    } catch (error) {
      this.logProbeFailure("beads metadata", error);
      return null;
    }
  }

  private scanObservabilityCandidates(root: string): Array<{ repoPath: string; dbPath: string; mtimeMs: number }> {
    const candidates: Array<{ repoPath: string; dbPath: string; mtimeMs: number }> = [];
    try {
      if (!statSync(root).isDirectory()) return [];
    } catch (error) {
      this.logProbeFailure("observability root", error);
      return [];
    }
    this.addObservabilityCandidate(root, candidates);
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !this.shouldSkip(entry.name)) this.addObservabilityCandidate(join(root, entry.name), candidates);
      }
    } catch (error) {
      this.logProbeFailure("observability root children", error);
    }
    return candidates;
  }

  private addObservabilityCandidate(repoPath: string, candidates: Array<{ repoPath: string; dbPath: string; mtimeMs: number }>): void {
    for (const relativePath of OBSERVABILITY_DB_PATHS) {
      const dbPath = join(repoPath, relativePath);
      try {
        const file = statSync(dbPath);
        if (file.isFile()) {
          candidates.push({ repoPath, dbPath, mtimeMs: file.mtimeMs });
          return;
        }
      } catch (error) {
        this.logProbeFailure("observability db", error);
      }
    }
  }

  private assignObsSlugs(entries: Array<{ repoPath: string; dbPath: string; mtimeMs: number }>): Array<{ repoSlug: string; repoPath: string; dbPath: string; mtimeMs: number }> {
    const seen = new Map<string, number>();
    return entries.map((entry) => {
      const base = basename(entry.repoPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { ...entry, repoSlug: count === 0 ? base : `${base}-${createHash("sha1").update(entry.repoPath).digest("hex").slice(0, 8)}` };
    });
  }

  private upsertDiscoveredSources(discovered: UnifiedSource[]): void {
    const statement = this.db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, ?, ?, 'discovered', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind, path=excluded.path, status=excluded.status, last_seen_at=excluded.last_seen_at");
    for (const source of discovered) statement.run(source.sourceKey, source.kind, source.path, source.status);
  }

  private markMissingSources(discovered: UnifiedSource[]): void {
    const rows = this.db.query("SELECT source_key FROM sources WHERE origin = 'discovered'").all() as Array<{ source_key: string }>;
    const missing = getMissingDiscoveredSourceKeys(discovered.map((source) => source.sourceKey), rows.map((row) => row.source_key));
    const statement = this.db.query("UPDATE sources SET status = 'missing' WHERE source_key = ? AND origin = 'discovered'");
    for (const sourceKey of missing) statement.run(sourceKey);
  }

  private async emitParityDiff(discovered: UnifiedSource[]): Promise<void> {
    const scanner = new ProjectScanner({
      searchPath: this.config.beadsSearchPath ?? process.env.XDG_PROJECTS_DIR ?? (process.env.HOME ? `${process.env.HOME}/projects` : "/home"),
      scanPaths: this.config.beadsScanPaths,
      maxDepth: 3,
      excludePatterns: ["node_modules", ".git", "dist", "build"],
    });
    const legacyBeads = await scanner.scanAll();
    const unified = new Map(discovered.map((source) => [source.sourceKey, `${source.kind}|${source.path}|${source.status}`]));
    const legacy = new Map<string, string>();
    for (const project of legacyBeads) legacy.set(`beads:${project.id}`, `beads|${join(project.path, ".beads")}|${normalizeLegacySourceStatus(project.status)}`);
    for (const repo of this.listObservabilityRepos()) legacy.set(`obs:${repo.repoSlug}`, `observability|${repo.dbPath}|active`);
    const added = [...unified.keys()].filter((key) => !legacy.has(key)).sort();
    const removed = [...legacy.keys()].filter((key) => !unified.has(key)).sort();
    const changed = [...unified].filter(([key, value]) => legacy.has(key) && legacy.get(key) !== value).map(([key]) => key).sort();
    if (added.length || removed.length || changed.length) this.log("parity.scanner", "warn", { added, removed, changed });
  }

  private shouldSkip(name: string): boolean {
    return name.startsWith(".") || BEADS_EXCLUDES.includes(name);
  }

  private isWorktreePath(path: string): boolean {
    return path.split(/[\\/]+/).some((part) => part === ".worktrees" || part === "worktrees");
  }

  private isGitWorktree(repoPath: string): boolean {
    try {
      const gitPath = join(repoPath, ".git");
      return lstatSync(gitPath).isFile() && readFileSync(gitPath, "utf-8").trim().startsWith("gitdir:");
    } catch (error) {
      this.logProbeFailure("git worktree probe", error);
      return false;
    }
  }

  private logProbeFailure(stage: string, pathOrError: unknown, maybeError?: unknown): void {
    const error = maybeError ?? pathOrError;
    const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "UNKNOWN";
    if (code === "ENOENT" || code === "ENOTDIR") return;
    this.log("scanner.probe", "warn", { stage, code });
  }

  private log(event: string, level: "info" | "warn" | "error", data: Record<string, unknown>): void {
    this.emitLog(makeLogEntry("system", event, level, undefined, { ...(this.owner ? { owner: this.owner } : {}), ...data }));
  }
}
