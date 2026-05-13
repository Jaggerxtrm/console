import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getRepos } from "../../core/github-store.ts";
import type { BeadsProject } from "../../../../beadboard/src/types/beads.ts";

interface ConsoleRepoRecord {
  id: string;
  name: string;
  path?: string;
  github?: {
    fullName: string;
    displayName: string;
    tracked: boolean;
    openPrs: number;
    closedPrs: number;
    openIssues: number;
    lastActivityAt: string | null;
  };
  beads?: {
    projectId: string;
    path: string;
    source: BeadsProject["source"];
    sourceHealth: BeadsProject["sourceHealth"];
    issueCount: number;
    open: number;
    inProgress: number;
    blocked: number;
    closed: number;
    epics: number;
    p0: number;
  };
  health: "active" | "idle" | "git-only" | "beads-only";
}

function getSearchPath(): string {
  return process.env.XDG_PROJECTS_DIR || (process.env.HOME ? `${process.env.HOME}/projects` : "/home");
}

async function scanBeadsProjects(): Promise<BeadsProject[]> {
  try {
    const entries = await withTimeout(readdir(getSearchPath(), { withFileTypes: true }), 500, []);
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !["node_modules", ".git", ".worktrees", "worktrees", "Library", "Applications", ".cargo", ".npm", ".rustup"].includes(entry.name))
      .map((entry) => withTimeout(loadBeadsProject(join(getSearchPath(), entry.name)), 150, null));
    const projects = await Promise.all(candidates);
    return projects.filter((project): project is BeadsProject => Boolean(project));
  } catch {
    return [];
  }
}

async function loadBeadsProject(repoPath: string): Promise<BeadsProject | null> {
  try {
    if (await isGitWorktree(repoPath)) return null;
    const beadsPath = join(repoPath, ".beads");
    const metadata = JSON.parse(await readFile(join(beadsPath, "metadata.json"), "utf-8")) as { project_id?: string; issue_count?: number };
    return {
      id: metadata.project_id || basename(repoPath),
      name: basename(repoPath),
      path: repoPath,
      beadsPath,
      source: "jsonl",
      sourceHealth: [{ kind: "jsonl", state: "available", path: join(beadsPath, "issues.jsonl") }],
      sourcePriority: ["jsonl"],
      status: "active",
      lastScanned: new Date().toISOString(),
      issueCount: metadata.issue_count ?? 0,
    };
  } catch {
    return null;
  }
}

async function isGitWorktree(repoPath: string): Promise<boolean> {
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

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export function createConsoleRouter(db: Database): Hono {
  const router = new Hono();

  router.get("/repos", async (c) => {
    const [githubRepos, beadsProjects] = await Promise.all([
      Promise.resolve(getRepos(db)),
      scanBeadsProjects(),
    ]);

    const records = new Map<string, ConsoleRepoRecord>();

    for (const repo of githubRepos) {
      const stats = getGithubRepoStats(db, repo.full_name);
      const key = repoKey(repo.full_name);
      records.set(key, {
        id: key,
        name: repo.display_name || key,
        github: {
          fullName: repo.full_name,
          displayName: repo.display_name || key,
          tracked: Boolean(repo.tracked),
          ...stats,
        },
        health: stats.openPrs > 0 || stats.openIssues > 0 ? "active" : "git-only",
      });
    }

    for (const project of beadsProjects) {
      const key = repoKey(project.name || basename(project.path));
      const beadStats = getBeadsMetadataStats(project);
      const existing = records.get(key);
      records.set(key, {
        id: existing?.id ?? key,
        name: existing?.name ?? project.name,
        path: project.path,
        github: existing?.github,
        beads: {
          projectId: project.id,
          path: project.path,
          source: project.source,
          sourceHealth: project.sourceHealth,
          ...beadStats,
        },
        health: existing?.github
          ? (beadStats.open + beadStats.inProgress + beadStats.blocked + (existing.github.openPrs ?? 0) > 0 ? "active" : "idle")
          : "beads-only",
      });
    }

    return c.json({ repos: [...records.values()].sort(sortConsoleRepos) });
  });

  return router;
}

function getGithubRepoStats(db: Database, fullName: string) {
  const prStats = db.query<{ openPrs: number; closedPrs: number }, [string]>(
    `SELECT
      COUNT(CASE WHEN state = 'open' THEN 1 END) AS openPrs,
      COUNT(CASE WHEN state IN ('closed', 'merged') THEN 1 END) AS closedPrs
     FROM github_prs WHERE repo = ?`,
  ).get(fullName) ?? { openPrs: 0, closedPrs: 0 };

  const issueStats = db.query<{ openIssues: number }, [string]>(
    `SELECT COUNT(CASE WHEN state = 'open' THEN 1 END) AS openIssues FROM github_issues WHERE repo = ?`,
  ).get(fullName) ?? { openIssues: 0 };

  const activity = db.query<{ lastActivityAt: string | null }, [string]>(
    `SELECT MAX(created_at) AS lastActivityAt FROM github_events WHERE repo = ?`,
  ).get(fullName) ?? { lastActivityAt: null };

  return { ...prStats, ...issueStats, ...activity };
}

function getBeadsMetadataStats(project: BeadsProject) {
  return {
    issueCount: project.issueCount || 0,
    open: project.issueCount || 0,
    inProgress: 0,
    blocked: 0,
    closed: 0,
    epics: 0,
    p0: 0,
  };
}

function repoKey(name: string): string {
  return name.split("/").pop()?.toLowerCase() || name.toLowerCase();
}

function sortConsoleRepos(a: ConsoleRepoRecord, b: ConsoleRepoRecord): number {
  const aActive = (a.github?.openPrs ?? 0) + (a.github?.openIssues ?? 0) + (a.beads?.open ?? 0) + (a.beads?.inProgress ?? 0) + (a.beads?.blocked ?? 0);
  const bActive = (b.github?.openPrs ?? 0) + (b.github?.openIssues ?? 0) + (b.beads?.open ?? 0) + (b.beads?.inProgress ?? 0) + (b.beads?.blocked ?? 0);
  if (aActive !== bActive) return bActive - aActive;
  return a.name.localeCompare(b.name);
}
