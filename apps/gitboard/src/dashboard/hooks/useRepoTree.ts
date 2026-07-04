// Aggregates github repos + beads projects into RepoNode[] for the shell.

import { useCallback, useEffect, useRef } from "react";
import { apiClient } from "../lib/client.ts";
import { substrateApi } from "../lib/beads.ts";
import { useShellStore } from "../stores/shell.ts";
import type { GithubChips, BeadsChips, BeadsSourceChip, RepoNode } from "../../types/shell.ts";
import type { GithubRepo, RepoStat, RepoStatsResponse } from "../../types/github.ts";
import type { BeadsConnectionStatus, BeadsProject, BeadsStats } from "../../types/beads.ts";
import { useWebSocket } from "./useWebSocket.ts";
import type { WsMessage } from "../lib/ws.ts";

const ZERO_GITHUB: GithubChips = { openPRs: 0, commitsToday: 0, openIssues: 0, releases: 0 };
const ZERO_BEADS: BeadsChips = { open: 0, inProgress: 0, blocked: 0, epics: 0 };
const WS_REFRESH_DEBOUNCE_MS = 500;

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
  const reposRef = useRef<GithubRepo[]>([]);
  const repoStatsByNameRef = useRef<Map<string, RepoStatsResponse["data"][number]>>(new Map());
  const projectsRef = useRef<BeadsProject[]>([]);
  const projectStatsRef = useRef<Map<string, BeadsStats | null>>(new Map());
  const projectConnectionRef = useRef<Map<string, BeadsConnectionStatus | null>>(new Map());
  const projectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const githubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuild = useCallback(() => {
    const repoStatsByName = repoStatsByNameRef.current;
    const beadsByTail = new Map<string, { project: BeadsProject; stats: BeadsStats | null; source: BeadsSourceChip }>();
    for (const project of projectsRef.current) {
      beadsByTail.set(project.name, {
        project,
        stats: projectStatsRef.current.get(project.id) ?? null,
        source: beadsSourceFromConnection(projectConnectionRef.current.get(project.id) ?? null),
      });
    }

    setRepos(buildRepoNodes(reposRef.current, repoStatsByName, beadsByTail));
  }, [setRepos]);

  const loadAll = useCallback(async () => {
    try {
      const [reposRes, statsRes, projects] = await Promise.all([
        apiClient.getRepos(),
        apiClient.getRepoStats().catch(() => ({ data: [] })),
        substrateApi.listProjects(),
      ]);
      reposRef.current = reposRes.data;
      repoStatsByNameRef.current = new Map(statsRes.data.map((stats) => [stats.full_name, stats]));
      projectsRef.current = projects;

      const projectStats = await Promise.all(
        projects.map(async (project) => {
          const [stats, connection] = await Promise.all([
            substrateApi.getStats(project.id).catch(() => null as BeadsStats | null),
            substrateApi.getConnection(project.id).catch(() => null as BeadsConnectionStatus | null),
          ]);
          return [project.id, stats, connection] as const;
        }),
      );
      projectStatsRef.current = new Map(projectStats.map(([projectId, stats]) => [projectId, stats]));
      projectConnectionRef.current = new Map(projectStats.map(([projectId, , connection]) => [projectId, connection]));
      rebuild();
    } catch (err) {
      console.warn("[useRepoTree] aggregation failed; preserving previous repo tree", err);
    }
  }, [rebuild]);

  const scheduleFullReload = useCallback(() => {
    if (reloadAllTimerRef.current) clearTimeout(reloadAllTimerRef.current);
    reloadAllTimerRef.current = setTimeout(() => void loadAll(), WS_REFRESH_DEBOUNCE_MS);
  }, [loadAll]);

  const scheduleProjectStats = useCallback((projectId: string | null) => {
    if (!projectId) {
      scheduleFullReload();
      return;
    }
    const existing = projectTimersRef.current.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      projectTimersRef.current.delete(projectId);
      try {
        const stats = await substrateApi.getStats(projectId);
        projectStatsRef.current.set(projectId, stats);
        rebuild();
      } catch {
        scheduleFullReload();
      }
    }, WS_REFRESH_DEBOUNCE_MS);
    projectTimersRef.current.set(projectId, timer);
  }, [rebuild, scheduleFullReload]);

  const scheduleGithubStats = useCallback(() => {
    if (githubTimerRef.current) clearTimeout(githubTimerRef.current);
    githubTimerRef.current = setTimeout(async () => {
      try {
        const statsRes = await apiClient.getRepoStats();
        repoStatsByNameRef.current = new Map(statsRes.data.map((stats) => [stats.full_name, stats]));
        rebuild();
      } catch {
        /* keep previous sidebar stats */
      }
    }, WS_REFRESH_DEBOUNCE_MS);
  }, [rebuild]);

  const handleSubstrateMessage = useCallback((msg: WsMessage) => {
    const data = asRecord(msg.data);
    const projectId = getProjectId(data);
    if (msg.event === "beads:source_health") {
      const connection = connectionFromSourceHealth(data);
      if (projectId && connection) {
        projectConnectionRef.current.set(projectId, connection);
        rebuild();
      }
      return;
    }
    if (msg.event === "substrate:sync_hint" || msg.event?.startsWith("beads:")) {
      scheduleProjectStats(projectId);
    }
  }, [rebuild, scheduleProjectStats]);

  const handleGithubMessage = useCallback((msg: WsMessage) => {
    if (msg.event?.startsWith("github:")) scheduleGithubStats();
  }, [scheduleGithubStats]);

  useEffect(() => {
    void loadAll();
    return () => {
      for (const timer of projectTimersRef.current.values()) clearTimeout(timer);
      projectTimersRef.current.clear();
      if (githubTimerRef.current) clearTimeout(githubTimerRef.current);
      if (reloadAllTimerRef.current) clearTimeout(reloadAllTimerRef.current);
    };
  }, [loadAll]);

  useWebSocket("substrate:changes", handleSubstrateMessage);
  useWebSocket("github:activity", handleGithubMessage);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function getProjectId(data: Record<string, unknown>): string | null {
  if (typeof data.project_id === "string") return data.project_id;
  if (typeof data.projectId === "string") return data.projectId;
  const project = asRecord(data.project);
  return typeof project.id === "string" ? project.id : null;
}

function connectionFromSourceHealth(data: Record<string, unknown>): BeadsConnectionStatus | null {
  const health = Array.isArray(data.health) ? asRecord(data.health[0]) : {};
  const source = typeof data.source === "string" ? data.source : typeof health.kind === "string" ? health.kind : undefined;
  const state = typeof health.state === "string" ? health.state : undefined;
  const healthy = typeof data.healthy === "boolean" ? data.healthy : state === "fresh";
  if (!source && !state) return null;
  return {
    source,
    status: source === "dolt" && healthy ? "dolt_connected" : source === "sqlite" && healthy ? "substrate_connected" : source === "jsonl" ? "jsonl_fallback" : state ?? "error",
    degraded: !healthy,
    message: typeof health.detail === "string" ? health.detail : undefined,
  };
}
