import type { RepoNode, SidebarSelection } from "../../types/shell.ts";
import type { ChainSummary } from "../hooks/useChains.ts";
import type { SpecialistJob } from "../../server/observability/types.ts";

export interface SpecialistRepoScope {
  repo: RepoNode | null;
  label: string;
  keys: string[];
}

export function getSpecialistRepoScope(selection: SidebarSelection, repos: RepoNode[]): SpecialistRepoScope {
  const repo = selection.repo ? repos.find((item) => item.fullName === selection.repo) ?? null : null;
  return {
    repo,
    label: repo?.beadsProjectName ?? repo?.beadsProjectId ?? repo?.displayName ?? "current project",
    keys: repo ? unique([repo.beadsProjectId, repo.beadsProjectName, repo.displayName, tailName(repo.fullName), repo.fullName]) : [],
  };
}

export function matchesSpecialistScope(job: Pick<SpecialistJob, "repoSlug">, keys: readonly string[]): boolean {
  return keys.length === 0 || keys.includes(job.repoSlug);
}

export function chainMatchesSpecialistScope(chain: ChainSummary, keys: readonly string[]): boolean {
  return keys.length === 0 || chain.jobs.some((job) => matchesSpecialistScope(job, keys));
}

function tailName(fullName: string): string {
  const index = fullName.lastIndexOf("/");
  return index >= 0 ? fullName.slice(index + 1) : fullName;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
