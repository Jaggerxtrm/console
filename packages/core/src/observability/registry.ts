import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { getObservabilityConfig, type ObservabilityConfig } from "./config.ts";

export interface RepoEntry {
  repoSlug: string;
  repoPath: string;
  dbPath: string;
  mtimeMs: number;
}

const REPO_REFRESH_MS = 10_000;

interface CacheEntry<T> {
  value: T;
  refreshAt: number;
}

let repoCache: CacheEntry<RepoEntry[]> | null = null;

export type ObservabilityConfigProvider = () => ObservabilityConfig;

export function __resetObservabilityRegistryForTests(): void {
  repoCache = null;
}

export function listRepos(configProvider: ObservabilityConfigProvider = getObservabilityConfig): RepoEntry[] {
  const cached = repoCache;
  const now = Date.now();
  if (cached && cached.refreshAt > now) return cached.value;

  const roots = configProvider().roots;
  if (roots.length === 0) {
    repoCache = { value: [], refreshAt: now + REPO_REFRESH_MS };
    return [];
  }

  const candidates = roots.flatMap(scanRoot);
  candidates.sort((left, right) => left.repoPath.localeCompare(right.repoPath));

  const repos = assignSlugs(candidates);
  repoCache = { value: repos, refreshAt: now + REPO_REFRESH_MS };
  return repos;
}

const OBSERVABILITY_DB_PATHS = [
  ".specialists/db/observability.db",
  ".specialists/observability.db",
  "observability.db",
] as const;

function scanRoot(root: string): Omit<RepoEntry, "repoSlug">[] {
  const repos = new Map<string, Omit<RepoEntry, "repoSlug">>();

  try {
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) return [];
  } catch {
    console.debug("[observability] skip unreadable root");
    return [];
  }

  addRepoCandidate(root, repos);

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) addRepoCandidate(join(root, entry.name), repos);
    }
  } catch {
    console.debug("[observability] skip unreadable root children");
  }

  return [...repos.values()];
}

function addRepoCandidate(repoPath: string, repos: Map<string, Omit<RepoEntry, "repoSlug">>): void {
  for (const relativeDbPath of OBSERVABILITY_DB_PATHS) {
    const dbPath = join(repoPath, relativeDbPath);
    try {
      const fileStat = statSync(dbPath);
      if (!fileStat.isFile()) continue;
      repos.set(repoPath, { repoPath, dbPath, mtimeMs: fileStat.mtimeMs });
      return;
    } catch {
      continue;
    }
  }
}

function assignSlugs(entries: Omit<RepoEntry, "repoSlug">[]): RepoEntry[] {
  const seen = new Map<string, number>();

  return entries.map((entry) => {
    const baseSlug = slugify(basename(entry.repoPath));
    const count = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, count + 1);

    const repoSlug = count === 0 ? baseSlug : `${baseSlug}-${shortHash(entry.repoPath)}`;
    return { ...entry, repoSlug };
  });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}
