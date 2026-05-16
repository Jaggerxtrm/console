// Sidebar (forge-7xu rebuild). Single-level repo list with RepoIcon octicons,
// grouped by groupName when present. Filtered by current surface (only show repos
// that have data on the active side).

import { useMemo } from "react";
import {
  RepoIcon,
  SidebarExpandIcon,
  ChevronLeftIcon,
} from "@primer/octicons-react";
import {
  useShellStore,
  selectRepos,
  selectSelection,
  selectSidebarCollapsed,
} from "../../stores/shell.ts";
import type { RepoNode } from "../../../types/shell.ts";

function groupRepos(repos: RepoNode[]): { name: string; repos: RepoNode[] }[] {
  const groups = new Map<string, RepoNode[]>();
  for (const r of repos) {
    const g = r.groupName?.trim() || "Ungrouped";
    const arr = groups.get(g) ?? [];
    arr.push(r);
    groups.set(g, arr);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b)))
    .map(([name, repos]) => ({
      name,
      repos: repos.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }));
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
                      surface={selection.surface}
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
  surface,
  onSelect,
}: {
  repo: RepoNode;
  active: boolean;
  surface: "github" | "beads";
  onSelect: () => void;
}) {
  const badge =
    surface === "beads"
      ? repo.openBeadsCount
      : repo.githubStats.openPRs;
  const badgeTitle =
    surface === "beads" ? `${badge} open beads` : `${badge} open PRs`;

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
      {badge > 0 && (
        <span className="ide-repo-badge" title={badgeTitle}>{badge}</span>
      )}
    </button>
  );
}
