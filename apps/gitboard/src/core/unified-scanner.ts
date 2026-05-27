import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { emit, makeLogEntry } from "./logger.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { getObservabilityConfig } from "../server/observability/config.ts";
import { listRepos } from "../server/observability/registry.ts";

type UnifiedSourceKind = "beads" | "observability";
type UnifiedSourceStatus = "active" | "missing";

export interface UnifiedScannerConfig {
  beadsSearchPath?: string;
  beadsScanPaths?: string[];
  observabilityRoots?: string[];
  refreshIntervalMs?: number;
  parityEnabled?: boolean;
}

export type UnifiedSource = {
  sourceKey: string;
  kind: UnifiedSourceKind;
  path: string;
  status: UnifiedSourceStatus;
};

export function formatSourceDisplayPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

export function normalizeLegacySourceStatus(status: string): "active" | "missing" {
  return status === "missing" ? "missing" : "active";
}

type LegacyBeadsProject = { id: string; path: string; status: string };
type LegacyObsRepo = { repoSlug: string; dbPath: string };
type ParityDiff = { added: string[]; removed: string[]; changed: string[] };
type SourceRow = { source_key: string; kind: string; path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null };

const DEFAULT_REFRESH_MS = 10 * 60 * 1000;
const DEFAULT_BEADS_SEARCH_PATH = process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home");
const BEADS_EXCLUDES = ["node_modules", ".git", "dist", "build", ".worktrees", "worktrees"];
const OBSERVABILITY_DB_PATHS = [".specialists/db/observability.db", ".specialists/observability.db", "observability.db"] as const;

export class UnifiedScanner {
  private readonly refreshIntervalMs: number;
  private readonly parityEnabled: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private refreshInFlight: Promise<UnifiedSource[]> | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: UnifiedScannerConfig = {},
  ) {
    this.refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.parityEnabled = config.parityEnabled ?? process.env.GITBOARD_ENABLE_PARITY === "1";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<UnifiedSource[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runRefresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async getSources(): Promise<Array<{ source_key: string; kind: string; display_path: string; origin: string; status: string; discovered_at: string | null; last_seen_at: string | null }>> {
    const rows = this.db.query<SourceRow, []>("SELECT source_key, kind, path, origin, status, discovered_at, last_seen_at FROM sources ORDER BY kind ASC, source_key ASC").all();
    return rows.map((row) => ({ source_key: row.source_key, kind: row.kind, display_path: formatSourceDisplayPath(row.path), origin: row.origin, status: row.status, discovered_at: row.discovered_at, last_seen_at: row.last_seen_at }));
  }

  private async scan(): Promise<UnifiedSource[]> {
    const beadsRoots = this.getBeadsRoots();
    const beads = (await Promise.all(beadsRoots.map((root) => this.scanBeadsRoot(root)))).flat();
    const obsRoots = this.getObservabilityRoots();
    const observabilityCandidates = obsRoots.flatMap((root) => this.scanObservabilityCandidates(root));
    const observability: UnifiedSource[] = this.assignObsSlugs(observabilityCandidates).map((entry) => ({ sourceKey: `obs:${entry.repoSlug}`, kind: "observability" as const, path: entry.dbPath, status: "active" as const }));
    return [...beads, ...observability];
  }

  private getBeadsRoots(): string[] {
    if (this.config.beadsScanPaths?.length) return this.config.beadsScanPaths;
    return this.config.beadsSearchPath ? [this.config.beadsSearchPath] : [DEFAULT_BEADS_SEARCH_PATH];
  }

  private getObservabilityRoots(): string[] {
    return this.config.observabilityRoots?.length ? this.config.observabilityRoots : getObservabilityConfig().roots;
  }

  private async scanBeadsRoot(root: string): Promise<UnifiedSource[]> {
    return this.scanBeadsPath(root, 0);
  }

  private async scanBeadsPath(dirPath: string, depth: number): Promise<UnifiedSource[]> {
    if (depth > 3) return [];
    if (this.isWorktreePath(dirPath) || this.isGitWorktree(dirPath)) return [];
    const discovered: UnifiedSource[] = [];
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const beadsDir = entries.find((entry) => entry.name === ".beads" && entry.isDirectory());
      if (beadsDir) {
        const projectId = await this.getBeadsProjectId(dirPath);
        if (projectId) discovered.push({ sourceKey: `beads:${projectId}`, kind: "beads" as const, path: join(dirPath, ".beads"), status: "active" as const });
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (BEADS_EXCLUDES.includes(entry.name)) continue;
        discovered.push(...await this.scanBeadsPath(join(dirPath, entry.name), depth + 1));
      }
    } catch (error) {
      this.logProbeFailure("beads scan", dirPath, error);
      return [];
    }
    return discovered;
  }

  private async getBeadsProjectId(repoPath: string): Promise<string | null> {
    try {
      const metadataContent = await readFile(join(repoPath, ".beads", "metadata.json"), "utf-8");
      const metadata = JSON.parse(metadataContent) as { project_id?: string };
      return metadata.project_id || basename(repoPath);
    } catch (error) {
      this.logProbeFailure("beads metadata", join(repoPath, ".beads", "metadata.json"), error);
      return null;
    }
  }

  private scanObservabilityCandidates(root: string): Array<{ repoPath: string; dbPath: string; mtimeMs: number }> {
    const candidates: Array<{ repoPath: string; dbPath: string; mtimeMs: number }> = [];
    try {
      if (!statSync(root).isDirectory()) return [];
    } catch (error) {
      this.logProbeFailure("observability root", root, error);
      return [];
    }
    this.addObservabilityCandidate(root, candidates);
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) this.addObservabilityCandidate(join(root, entry.name), candidates);
      }
    } catch (error) {
      this.logProbeFailure("observability root children", root, error);
      return candidates;
    }
    return candidates;
  }

  private addObservabilityCandidate(repoPath: string, candidates: Array<{ repoPath: string; dbPath: string; mtimeMs: number }>): void {
    for (const relativeDbPath of OBSERVABILITY_DB_PATHS) {
      const dbPath = join(repoPath, relativeDbPath);
      try {
        const fileStat = statSync(dbPath);
        if (!fileStat.isFile()) continue;
        candidates.push({ repoPath, dbPath, mtimeMs: fileStat.mtimeMs });
        return;
      } catch (error) {
        this.logProbeFailure("observability db", dbPath, error);
        continue;
      }
    }
  }

  private assignObsSlugs(entries: Array<{ repoPath: string; dbPath: string; mtimeMs: number }>): Array<{ repoSlug: string; repoPath: string; dbPath: string; mtimeMs: number }> {
    const seen = new Map<string, number>();
    return entries.map((entry) => {
      const baseSlug = this.slugify(basename(entry.repoPath));
      const count = seen.get(baseSlug) ?? 0;
      seen.set(baseSlug, count + 1);
      const repoSlug = count === 0 ? baseSlug : `${baseSlug}-${this.shortHash(entry.repoPath)}`;
      return { ...entry, repoSlug };
    });
  }

  private shortHash(value: string): string {
    return createHash("sha1").update(value).digest("hex").slice(0, 8);
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  }

  private async runRefresh(): Promise<UnifiedSource[]> {
    const discovered = await this.scan();
    this.upsertDiscoveredSources(discovered);
    this.markMissingSources(discovered);
    emit(makeLogEntry("system", "scanner.refresh", "info", undefined, { total: discovered.length, kinds: this.countKinds(discovered) }));
    if (this.parityEnabled) await this.emitParityDiff(discovered);
    return discovered;
  }

  private upsertDiscoveredSources(discovered: UnifiedSource[]): void {
    const stmt = this.db.query("INSERT INTO sources (source_key, kind, path, origin, status, discovered_at, last_seen_at) VALUES (?, ?, ?, 'discovered', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET kind=excluded.kind, path=excluded.path, status=excluded.status, last_seen_at=excluded.last_seen_at");
    for (const source of discovered) stmt.run(source.sourceKey, source.kind, source.path, source.status);
  }

  private markMissingSources(discovered: UnifiedSource[]): void {
    const discoveredKeys = new Set(discovered.map((source) => source.sourceKey));
    const rows = this.db.query("SELECT source_key FROM sources WHERE origin = 'discovered'").all() as Array<{ source_key: string }>;
    const stmt = this.db.query("UPDATE sources SET status = 'missing' WHERE source_key = ? AND origin = 'discovered'");
    for (const row of rows) {
      if (discoveredKeys.has(row.source_key)) continue;
      stmt.run(row.source_key);
    }
  }

  private async emitParityDiff(discovered: UnifiedSource[]): Promise<void> {
    const legacyBeads = await this.getLegacyBeads();
    const legacyObs = listRepos();
    const parity = this.diffSources(discovered, legacyBeads, legacyObs);
    if (parity.added.length === 0 && parity.removed.length === 0 && parity.changed.length === 0) return;
    emit(makeLogEntry("system", "parity.scanner", "warn", undefined, parity));
  }

  private async getLegacyBeads(): Promise<LegacyBeadsProject[]> {
    return new ProjectScanner({
      searchPath: this.config.beadsSearchPath ?? DEFAULT_BEADS_SEARCH_PATH,
      scanPaths: this.config.beadsScanPaths,
      maxDepth: 3,
      excludePatterns: ["node_modules", ".git", "dist", "build"],
    }).scanAll();
  }

  private diffSources(discovered: UnifiedSource[], legacyBeads: LegacyBeadsProject[], legacyObs: LegacyObsRepo[]): ParityDiff {
    const unified = new Map(discovered.map((source) => [source.sourceKey, `${source.kind}|${source.path}|${source.status}`]));
    const legacy = new Map<string, string>();
    for (const project of legacyBeads) legacy.set(`beads:${project.id}`, `beads|${join(project.path, ".beads")}|${normalizeLegacySourceStatus(project.status)}`);
    for (const repo of legacyObs) legacy.set(`obs:${repo.repoSlug}`, `observability|${repo.dbPath}|active`);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [key, value] of unified) {
      const legacyValue = legacy.get(key);
      if (!legacyValue) added.push(key);
      else if (legacyValue !== value) changed.push(key);
    }
    for (const key of legacy.keys()) {
      if (!unified.has(key)) removed.push(key);
    }
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
  }

  private countKinds(discovered: UnifiedSource[]): Record<UnifiedSourceKind, number> {
    return discovered.reduce((counts, source) => {
      counts[source.kind] += 1;
      return counts;
    }, { beads: 0, observability: 0 } as Record<UnifiedSourceKind, number>);
  }

  private isWorktreePath(dirPath: string): boolean {
    return dirPath.split(/[\\/]+/).some((part) => part === ".worktrees" || part === "worktrees");
  }

  private isGitWorktree(repoPath: string): boolean {
    try {
      const gitPath = join(repoPath, ".git");
      const gitStat = lstatSync(gitPath);
      if (!gitStat.isFile()) return false;
      const gitFile = readFileSync(gitPath, "utf-8");
      return gitFile.trim().startsWith("gitdir:");
    } catch (error) {
      this.logProbeFailure("git worktree probe", join(repoPath, ".git"), error);
      return false;
    }
  }

  private logProbeFailure(stage: string, path: string, error: unknown): void {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      console.debug(`[scanner] ${stage} miss ${path}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    emit(makeLogEntry("system", "scanner.probe", "warn", undefined, { stage, path, error: message }));
  }
}

