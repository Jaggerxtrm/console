// Server-side GitHub source for the Mercury programme read model.
// The source resolves master once per snapshot build and pins every Contents /
// history read to that exact SHA. Credentials remain server-side.

import { fetchRepoFile, listRepoDir } from "../../../../../packages/core/src/github/readme.ts";
import { getGithubToken } from "../../../../../packages/core/src/github/token.ts";
import type { ProgrammeActivity } from "../../types/programme.ts";
import type { ProgrammeSource } from "./read-model.ts";

const FETCH_TIMEOUT_MS = 3_000;
const PROGRAMME_OWNER = "mercuryintelligence";
const PROGRAMME_REPO = "program";
const PROGRAMME_BRANCH = "master";

interface CommitEnvelope {
  sha: string;
  commit?: { committer?: { date?: string }; message?: string };
  html_url?: string;
}

export type ObservableProgrammeSource = ProgrammeSource & {
  /** Exact immutable SHA used for all reads when the source is pinned. */
  pinnedSha?: string | null;
  /** Resolve the configured branch to one immutable source for a snapshot build. */
  pin?: () => Promise<ProgrammeSource>;
  /** Records transport/list failures even if a higher-level optional walk catches them. */
  sourceError?: () => string | null;
};

async function ghFetchJson<T>(url: string): Promise<T> {
  const token = getGithubToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitboard",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return await res.json() as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`GitHub request timed out after ${FETCH_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCommits(owner: string, repo: string, ref: string, perPage: number, path?: string): Promise<CommitEnvelope[]> {
  const params = new URLSearchParams({ sha: ref, per_page: String(perPage) });
  if (path) params.set("path", path);
  return ghFetchJson<CommitEnvelope[]>(`https://api.github.com/repos/${owner}/${repo}/commits?${params}`);
}

function toActivity(owner: string, repo: string, commit: CommitEnvelope): ProgrammeActivity {
  return {
    sha: commit.sha,
    date: commit.commit?.committer?.date ?? "",
    subject: (commit.commit?.message ?? "").split("\n")[0].slice(0, 200),
    url: commit.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
  };
}

export function createGithubProgrammeSource(options?: {
  owner?: string;
  repo?: string;
  branch?: string;
}): ObservableProgrammeSource {
  const owner = options?.owner ?? PROGRAMME_OWNER;
  const repo = options?.repo ?? PROGRAMME_REPO;
  const branch = options?.branch ?? PROGRAMME_BRANCH;

  const makeSource = (pinnedSha: string | null): ObservableProgrammeSource => {
    let lastSourceError: string | null = null;
    const ref = pinnedSha ?? branch;
    const observe = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        lastSourceError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };

    const read: ProgrammeSource["read"] = async (path) => observe(async () => {
      const entry = await fetchRepoFile(owner, repo, path, ref);
      return entry ? entry.content : null;
    });

    const listDir: ProgrammeSource["listDir"] = async (path) => observe(async () => {
      const entries = await listRepoDir(owner, repo, path, ref);
      return entries
        .map((entry) => (path ? `${path}/${entry.name}` : entry.name))
        .sort();
    });

    const source: ObservableProgrammeSource = {
      read,
      listDir,
      repository: `${owner}/${repo}`,
      branch,
      pinnedSha,
      sourceError: () => lastSourceError,
      recentCommits: async (n) => observe(async () => {
        const commits = await fetchCommits(owner, repo, ref, n);
        return commits.map((commit) => toActivity(owner, repo, commit));
      }),
      timestamp: async (path) => observe(async () => {
        const commits = await fetchCommits(owner, repo, ref, 1, path);
        return commits[0]?.commit?.committer?.date ?? null;
      }),
    };

    source.pin = async () => {
      if (pinnedSha) return source;
      const commits = await observe(() => fetchCommits(owner, repo, branch, 1));
      const sha = commits[0]?.sha;
      if (!sha) throw new Error(`Unable to resolve ${owner}/${repo}@${branch} to an exact commit`);
      return makeSource(sha);
    };

    return source;
  };

  return makeSource(null);
}
