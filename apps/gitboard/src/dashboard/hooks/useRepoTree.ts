// Aggregates github repos + beads projects into RepoNode[] for the shell.

import { useEffect } from "react";
import { apiClient } from "../lib/client.ts";
import { substrateApi } from "../lib/substrate-api.ts";
import { useShellStore } from "../stores/shell.ts";
import type { GithubChips, BeadsChips, BeadsSourceChip, RepoNode } from "../../types/shell.ts";
import type { BeadsConnectionStatus, BeadsProject, BeadsStats } from "../../types/beads.ts";

const ZERO_GITHUB: GithubChips = { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 };
const ZERO_BEADS: BeadsChips = { open: 0, inProgress: 0, blocked: 0, epics: 0 };
const REFRESH_MS = 10_000;

function tailName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

function beadsChipsFromStats(stats: BeadsStats | null): BeadsChips {
  if (!stats) return ZERO_BEADS;
  return {
    open: stats.open ?? 0,
    inProgress: stats.in_progress ?? 0,
    blocked: stats.blocked ?? 0,
    epics: stats.by_type?.epic ?? 0,
  };
}

export function normalizeProjectKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function findBeadsSide(tail: string, beadsByName: Map<string, { project: BeadsProject; stats: BeadsStats | null; source: BeadsSourceChip }>) {
  const exact = beadsByName.get(tail);
  if (exact) return exact;

  const normalizedTail = normalizeProjectKey(tail);
  const matches = [...beadsByName.values()]
    .map((entry) => ({ entry, key: normalizeProjectKey(entry.project.name) }))
    .filter(({ key }) => normalizedTail === key || normalizedTail.endsWith(`-${key}`) || key.endsWith(`-${normalizedTail}`))
    .sort((a, b) => b.key.length - a.key.length);
  return matches[0]?.entry ?? null;
}

function beadsSourceFromConnection(connection: BeadsConnectionStatus | null): BeadsSourceChip {
  if (!connection) return { label: "unknown", title: "Beads source unknown", healthy: false };
  if (connection.status === "dolt_connected" || connection.status === "connected" || (connection.source === "dolt" && !connection.degraded)) {
    const port = connection.port ? `:${connection.port}` : "";
    return { label: "dolt", title: connection.message ?? `Dolt connected${port}`, healthy: true };
  }
  if (connection.status === "substrate_connected" || connection.source === "sqlite") {
    return { label: "sqlite", title: connection.message ?? "xtrm.sqlite substrate connected", healthy: true };
  }
  if (connection.source === "jsonl" || connection.degraded || connection.status === "jsonl_fallback" || connection.status === "no_dolt") {
    return { label: "jsonl", title: connection.message ?? connection.error ?? connection.note ?? "Dolt unavailable; reading JSONL backup. Data may be stale.", healthy: false };
  }
  if (connection.status === "not_found") return { label: "missing", title: connection.error ?? connection.message ?? "Beads project not found", healthy: false };
  return { label: "error", title: connection.error ?? connection.message ?? connection.note ?? `Beads source status: ${connection.status}`, healthy: false };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function useRepoTree(): void {
  const setRepos = useShellStore((s) => s.setRepos);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [reposRes, statsRes, projects] = await Promise.all([
          apiClient.getRepos(),
          apiClient.getRepoStats().catch(() => ({ data: [] })),
          substrateApi.listProjects(),
        ]);
        if (cancelled) return;

        const repoStatsByName = new Map(statsRes.data.map((s) => [s.full_name, s]));
        const projectStats = await Promise.all(
          projects.map(async (p) => {
            const [stats, connection] = await Promise.all([
              substrateApi.getStats(p.id).catch(() => null as BeadsStats | null),
              substrateApi.getConnection(p.id).catch(() => null as BeadsConnectionStatus | null),
            ]);
            return [p, stats, connection] as const;
          }),
        );
        if (cancelled) return;

        const beadsByTail = new Map<string, { project: BeadsProject; stats: BeadsStats | null; source: BeadsSourceChip }>();
        for (const [project, stats, connection] of projectStats) {
          beadsByTail.set(project.name, { project, stats, source: beadsSourceFromConnection(connection) });
        }

        const matched = new Set<string>();
        const nodes: RepoNode[] = [];

        for (const repo of reposRes.data) {
          const tail = tailName(repo.full_name);
          const beadsSide = findBeadsSide(tail, beadsByTail);
          if (beadsSide) matched.add(beadsSide.project.name);
          const stats = repoStatsByName.get(repo.full_name);
          const githubStats: GithubChips = {
            openPRs: stats?.prs_open ?? 0,
            commitsToday: stats?.pushes ?? 0,
            openIssues: stats?.issues_open ?? 0,
            releases: stats?.releases ?? 0,
          };
          const beadsStats = beadsChipsFromStats(beadsSide?.stats ?? null);
          nodes.push({
            fullName: repo.full_name,
            displayName: repo.display_name ?? repo.full_name,
            groupName: repo.group_name ?? null,
            lastActivityAt: maxIso(stats?.last_event_at ?? null, beadsSide?.stats?.last_activity_at ?? null),
            openBeadsCount: beadsStats.open + beadsStats.inProgress + beadsStats.blocked,
            githubStats,
            beadsStats,
            beadsSource: beadsSide?.source ?? null,
            beadsProjectId: beadsSide?.project.id ?? null,
            beadsProjectName: beadsSide?.project.name ?? null,
            hasGithub: true,
            hasBeads: Boolean(beadsSide),
          });
        }

        // Beads-only orphans
        for (const [tail, { project, stats, source }] of beadsByTail) {
          if (matched.has(tail)) continue;
          const beadsStats = beadsChipsFromStats(stats);
          nodes.push({
            fullName: project.name,
            displayName: project.name,
            groupName: null,
            lastActivityAt: stats?.last_activity_at ?? null,
            openBeadsCount: beadsStats.open + beadsStats.inProgress + beadsStats.blocked,
            githubStats: ZERO_GITHUB,
            beadsStats,
            beadsSource: source,
            beadsProjectId: project.id,
            beadsProjectName: project.name,
            hasGithub: false,
            hasBeads: true,
          });
        }

        setRepos(nodes);
      } catch (err) {
        console.warn("[useRepoTree] aggregation failed; preserving previous repo tree", err);
      }
    }

    void load();
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setRepos]);
}
