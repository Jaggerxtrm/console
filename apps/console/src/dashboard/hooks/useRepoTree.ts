// Aggregates github repos + beads projects into RepoNode[] for the shell.

import { useEffect } from "react";
import { apiClient } from "../lib/client.ts";
import { substrateApi } from "../lib/beads.ts";
import { useShellStore } from "../stores/shell.ts";
import type { GithubChips, BeadsChips, BeadsSourceChip, RepoNode } from "../../types/shell.ts";
import type { BeadsConnectionStatus, BeadsProject, BeadsStats } from "../../types/beads.ts";
import type { GithubRepo, RepoStat } from "../../types/github.ts";

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

type BeadsSide = { project: BeadsProject; stats: BeadsStats | null; source: BeadsSourceChip };

// Sums GitHub activity across all aliases that resolve to one Beads project so the
// canonical row never drops counts when old-owner/new-owner aliases collapse.
function aggregateGithubStats(aliases: GithubRepo[], repoStatsByName: Map<string, RepoStat>): { chips: GithubChips; lastEventAt: string | null } {
  let openPRs = 0;
  let commitsToday = 0;
  let openIssues = 0;
  let releases = 0;
  let lastEventAt: string | null = null;
  for (const repo of aliases) {
    const stats = repoStatsByName.get(repo.full_name);
    if (!stats) continue;
    openPRs += stats.prs_open ?? 0;
    commitsToday += stats.pushes ?? 0;
    openIssues += stats.issues_open ?? 0;
    releases += stats.releases ?? 0;
    lastEventAt = maxIso(lastEventAt, stats.last_event_at ?? null);
  }
  return { chips: { openPRs, commitsToday, openIssues, releases }, lastEventAt };
}

// Deterministic canonical pick: prefer the alias whose tail matches the Beads project
// name, otherwise the lexicographically smallest full_name for stable ordering.
function canonicalAlias(aliases: GithubRepo[], projectName: string): GithubRepo {
  const normalizedProject = normalizeProjectKey(projectName);
  const exact = aliases.find((repo) => normalizeProjectKey(tailName(repo.full_name)) === normalizedProject);
  if (exact) return exact;
  return [...aliases].sort((a, b) => a.full_name.localeCompare(b.full_name))[0];
}

function makeGithubNode(canonical: GithubRepo, aliases: GithubRepo[], repoStatsByName: Map<string, RepoStat>, beadsSide: BeadsSide | null): RepoNode {
  const { chips: githubStats, lastEventAt } = aggregateGithubStats(aliases, repoStatsByName);
  const beadsStats = beadsChipsFromStats(beadsSide?.stats ?? null);
  return {
    fullName: canonical.full_name,
    displayName: canonical.display_name ?? canonical.full_name,
    groupName: canonical.group_name ?? null,
    lastActivityAt: maxIso(lastEventAt, beadsSide?.stats?.last_activity_at ?? null),
    openBeadsCount: beadsStats.open + beadsStats.inProgress + beadsStats.blocked,
    githubStats,
    beadsStats,
    beadsSource: beadsSide?.source ?? null,
    beadsProjectId: beadsSide?.project.id ?? null,
    beadsProjectName: beadsSide?.project.name ?? null,
    hasGithub: true,
    hasBeads: Boolean(beadsSide),
  };
}

// Builds the sidebar repo list, collapsing GitHub aliases that resolve to the same
// Beads project into one canonical row while preserving aggregated GitHub metadata
// and Beads counts/health. Unmatched GitHub repos and Beads-only orphans stay as-is.
export function buildRepoNodes(repos: GithubRepo[], repoStatsByName: Map<string, RepoStat>, beadsByTail: Map<string, BeadsSide>): RepoNode[] {
  const matched = new Set<string>();
  const groups = new Map<string, GithubRepo[]>();
  const unmatched: GithubRepo[] = [];

  for (const repo of repos) {
    const tail = tailName(repo.full_name);
    const beadsSide = findBeadsSide(tail, beadsByTail);
    if (!beadsSide) {
      unmatched.push(repo);
      continue;
    }
    matched.add(beadsSide.project.name);
    const list = groups.get(beadsSide.project.name);
    if (list) list.push(repo);
    else groups.set(beadsSide.project.name, [repo]);
  }

  const nodes: RepoNode[] = [];
  for (const repo of unmatched) {
    nodes.push(makeGithubNode(repo, [repo], repoStatsByName, null));
  }
  for (const [projectName, aliases] of groups) {
    const beadsSide = beadsByTail.get(projectName) ?? null;
    nodes.push(makeGithubNode(canonicalAlias(aliases, projectName), aliases, repoStatsByName, beadsSide));
  }

  // Beads-only orphans
  for (const [projectName, { project, stats, source }] of beadsByTail) {
    if (matched.has(projectName)) continue;
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
  return nodes;
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

        setRepos(buildRepoNodes(reposRes.data, repoStatsByName, beadsByTail));
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
