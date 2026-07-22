import type { Database } from "bun:sqlite";
import { getGithubToken } from "./token.ts";
import { upsertRepo } from "./store.ts";

export interface DiscoveredRepo {
  full_name: string;
  is_private: boolean;
  pushed_at: string | null;
}

export interface DiscoverOptions {
  maxAgeDays?: number;      // default 180 — only track repos pushed in last 6 months
  includePrivate?: boolean; // default true
}

export function discoverViaGhCli(
  spawnSync: typeof Bun.spawnSync = Bun.spawnSync,
): DiscoveredRepo[] {
  const result = spawnSync([
    "gh", "repo", "list",
    "--json", "nameWithOwner,isPrivate,pushedAt",
    "--limit", "100",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`gh repo list failed: ${result.stderr.toString().trim()}`);
  }

  const raw = JSON.parse(result.stdout.toString()) as Array<{
    nameWithOwner: string;
    isPrivate: boolean;
    pushedAt: string | null;
  }>;

  return raw.map((r) => ({
    full_name: r.nameWithOwner,
    is_private: r.isPrivate,
    pushed_at: r.pushedAt,
  }));
}

export async function discoverViaApi(token: string): Promise<DiscoveredRepo[]> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "agent-forge/0.1.0",
  };

  const repos: DiscoveredRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} fetching user repos`);
    }

    const raw = await response.json() as Array<{
      full_name: string;
      private: boolean;
      pushed_at: string | null;
    }>;

    if (raw.length === 0) break;

    for (const r of raw) {
      repos.push({
        full_name: r.full_name,
        is_private: r.private,
        pushed_at: r.pushed_at,
      });
    }

    if (raw.length < 100) break;
  }

  return repos;
}

export function filterRepos(repos: DiscoveredRepo[], options?: DiscoverOptions): DiscoveredRepo[] {
  const maxAgeDays = options?.maxAgeDays ?? 180;
  const includePrivate = options?.includePrivate ?? true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);

  return repos.filter((r) => {
    if (r.pushed_at === null) return false;
    if (new Date(r.pushed_at) < cutoff) return false;
    if (!includePrivate && r.is_private) return false;
    return true;
  });
}

export async function discoverAndInsert(
  db: Database,
  options?: DiscoverOptions,
  spawnSync?: typeof Bun.spawnSync,
): Promise<string[]> {
  let discovered: DiscoveredRepo[];

  try {
    discovered = discoverViaGhCli(spawnSync);
    console.log(`[github-discover] Found ${discovered.length} repos via gh CLI`);
  } catch (err) {
    console.warn(`[github-discover] gh CLI failed (${(err as Error).message}), falling back to REST API`);
    const token = getGithubToken();
    discovered = await discoverViaApi(token);
    console.log(`[github-discover] Found ${discovered.length} repos via REST API`);
  }

  const filtered = filterRepos(discovered, options);
  console.log(`[github-discover] ${filtered.length} repos match filters (of ${discovered.length} discovered)`);

  for (const repo of filtered) {
    upsertRepo(db, {
      full_name: repo.full_name,
      display_name: repo.full_name.split("/")[1],
      tracked: true,
      group_name: null,
      last_polled_at: null,
      color: null,
    });
  }

  return filtered.map((r) => r.full_name);
}
