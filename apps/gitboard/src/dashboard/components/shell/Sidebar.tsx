// Sidebar (forge-7xu rebuild). Single-level repo list with RepoIcon octicons.
// Filtered by current surface and ordered globally by latest real activity.

import { useMemo } from "react";
import {
  RepoIcon,
  SidebarExpandIcon,
  ChevronLeftIcon,
  GitPullRequestIcon,
  GitCommitIcon,
  IssueOpenedIcon,
  TagIcon,
  CircleIcon,
} from "@primer/octicons-react";
import {
  useShellStore,
  selectRepos,
  selectSelection,
  selectSidebarCollapsed,
} from "../../stores/shell.ts";
import type { RepoNode } from "../../../types/shell.ts";

function byRecencyDesc(a: RepoNode, b: RepoNode): number {
  // null lastActivityAt sinks to the bottom
  if (!a.lastActivityAt && !b.lastActivityAt) return a.displayName.localeCompare(b.displayName);
  if (!a.lastActivityAt) return 1;
  if (!b.lastActivityAt) return -1;
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function groupRepos(repos: RepoNode[]): { name: string; repos: RepoNode[] }[] {
  return [{ name: "Ungrouped", repos: [...repos].sort(byRecencyDesc) }];
}

export function Sidebar() {
  const repos = useShellStore(selectRepos);
  const selection = useShellStore(selectSelection);
  const setRepo = useShellStore((s) => s.setRepo);
  const collapsed = useShellStore(selectSidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);

  const filtered = useMemo(
    () =>
      repos.filter((r) => (selection.surface === "github" ? r.hasGithub : r.hasBeads)),
    [repos, selection.surface],
  );
  const groups = useMemo(() => groupRepos(filtered), [filtered]);

  return (
    <aside
      className="ide-sidebar"
      data-collapsed={collapsed || undefined}
      aria-label="Repositories"
    >
      <div className="ide-sidebar-header">
        {!collapsed && (
          <span className="ide-sidebar-title">
            {selection.surface === "github" ? "REPOSITORIES" : "PROJECTS"}
            <span className="ide-sidebar-count">{filtered.length}</span>
          </span>
        )}
        <button
          type="button"
          className="ide-sidebar-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          {collapsed ? <SidebarExpandIcon size={14} /> : <ChevronLeftIcon size={14} />}
        </button>
      </div>
      {!collapsed && (
        <div className="ide-sidebar-body">
          {groups.map((g) => (
            <section key={g.name} className="ide-sidebar-group">
              {g.name !== "Ungrouped" && (
                <h2 className="ide-sidebar-group-title">{g.name}</h2>
              )}
              <ul className="ide-sidebar-list" role="list">
                {g.repos.map((r) => (
                  <li key={r.fullName}>
                    <RepoRow
                      repo={r}
                      active={selection.repo === r.fullName}
                      onSelect={() => setRepo(r.fullName)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

function RepoRow({
  repo,
  active,
  onSelect,
}: {
  repo: RepoNode;
  active: boolean;
  onSelect: () => void;
}) {
  const prs = repo.githubStats.openPRs;
  const commits = repo.githubStats.commitsToday;
  const issues = repo.githubStats.openIssues;
  const releases = repo.githubStats.releases;
  const beads = repo.openBeadsCount;

  return (
    <button
      type="button"
      className={active ? "ide-repo-row is-active" : "ide-repo-row"}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      title={repo.fullName}
    >
      <span className="ide-repo-icon" aria-hidden="true">
        <RepoIcon size={14} />
      </span>
      <span className="ide-repo-name">{repo.displayName}</span>
      <span className="ide-repo-stats" aria-hidden="true">
        {prs > 0 && (
          <span className="ide-stat-chip ide-stat-chip-pr" title={`${prs} PRs opened today`}>
            <GitPullRequestIcon size={11} />
            <span className="ide-stat-chip-num">{prs}</span>
          </span>
        )}
        {commits > 0 && (
          <span className="ide-stat-chip ide-stat-chip-commit" title={`${commits} push events today`}>
            <GitCommitIcon size={11} />
            <span className="ide-stat-chip-num">{commits}</span>
          </span>
        )}
        {issues > 0 && (
          <span className="ide-stat-chip ide-stat-chip-issue" title={`${issues} issues opened today`}>
            <IssueOpenedIcon size={11} />
            <span className="ide-stat-chip-num">{issues}</span>
          </span>
        )}
        {releases > 0 && (
          <span className="ide-stat-chip ide-stat-chip-release" title={`${releases} releases today`}>
            <TagIcon size={11} />
            <span className="ide-stat-chip-num">{releases}</span>
          </span>
        )}
        {beads > 0 && (
          <span className="ide-stat-chip ide-stat-chip-beads" title={`${beads} open beads`}>
            <CircleIcon size={10} />
            <span className="ide-stat-chip-num">{beads}</span>
          </span>
        )}
      </span>
    </button>
  );
}
