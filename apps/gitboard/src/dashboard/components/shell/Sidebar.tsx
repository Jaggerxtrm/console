// File-tree Sidebar (forge-5w9.4 + forge-ci9 third-level).
// Three levels: /repo → /github + /beads → activity/prs/issues/releases (and beads leaves).
// ARIA tree, keyboard nav, compact 22px rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  ChevronLeftIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  TagIcon,
  ProjectIcon,
  RepoIcon,
  GraphIcon,
  SidebarExpandIcon,
} from "@primer/octicons-react";
import {
  useShellStore,
  selectRepos,
  selectExpanded,
  selectActiveSection,
} from "../../stores/shell.ts";
import type {
  LeafId,
  RepoNode,
  RepoSection,
} from "../../../types/shell.ts";
import { GITHUB_LEAVES, BEADS_LEAVES } from "../../../types/shell.ts";

type RowKind = "repo" | "section" | "leaf";

interface FlatRow {
  kind: RowKind;
  repo: RepoNode;
  section?: RepoSection;
  leaf?: LeafId;
  level: 1 | 2 | 3;
  id: string;
}

function sectionKey(repo: string, section: RepoSection): string {
  return `${repo}::${section}`;
}

const LEAF_ICONS: Record<string, typeof GitPullRequestIcon> = {
  activity: GraphIcon,
  prs: GitPullRequestIcon,
  issues: IssueOpenedIcon,
  releases: TagIcon,
  kanban: ProjectIcon,
};

function leafIcon(id: LeafId): typeof GitPullRequestIcon {
  return LEAF_ICONS[id] ?? IssueOpenedIcon;
}

function leafCount(repo: RepoNode, section: RepoSection, leaf: LeafId): number {
  if (section === "github") {
    const g = repo.githubStats;
    if (leaf === "activity") return g.commitsToday;
    if (leaf === "prs") return g.openPRs;
    if (leaf === "issues") return g.openIssues;
    if (leaf === "releases") return g.releases;
  } else {
    const b = repo.beadsStats;
    if (leaf === "kanban") return repo.openBeadsCount;
    if (leaf === "issues") return b.open + b.inProgress + b.blocked;
  }
  return 0;
}

function buildVisibleRows(repos: RepoNode[], expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const repo of repos) {
    rows.push({ kind: "repo", repo, level: 1, id: `r:${repo.fullName}` });
    if (!expanded.has(repo.fullName)) continue;

    if (repo.hasGithub) {
      const sk = sectionKey(repo.fullName, "github");
      rows.push({ kind: "section", repo, section: "github", level: 2, id: `s:${sk}` });
      if (expanded.has(sk)) {
        for (const leaf of GITHUB_LEAVES) {
          rows.push({
            kind: "leaf", repo, section: "github", leaf: leaf.id, level: 3,
            id: `l:${sk}:${leaf.id}`,
          });
        }
      }
    }
    if (repo.hasBeads) {
      const sk = sectionKey(repo.fullName, "beads");
      rows.push({ kind: "section", repo, section: "beads", level: 2, id: `s:${sk}` });
      if (expanded.has(sk)) {
        for (const leaf of BEADS_LEAVES) {
          rows.push({
            kind: "leaf", repo, section: "beads", leaf: leaf.id, level: 3,
            id: `l:${sk}:${leaf.id}`,
          });
        }
      }
    }
  }
  return rows;
}

function recencyHue(iso: string | null): string {
  if (!iso) return "var(--text-muted)";
  const ageMs = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (ageMs < day) return "var(--accent-green)";
  if (ageMs < 7 * day) return "var(--accent-orange)";
  return "var(--text-muted)";
}

function formatActivity(iso: string | null): string {
  if (!iso) return "no activity";
  return `last activity ${new Date(iso).toLocaleString()}`;
}

export function Sidebar() {
  const repos = useShellStore(selectRepos);
  const expanded = useShellStore(selectExpanded);
  const selection = useShellStore(selectActiveSection);
  const toggleExpand = useShellStore((s) => s.toggleExpand);
  const select = useShellStore((s) => s.select);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);

  const visible = useMemo(() => buildVisibleRows(repos, expanded), [repos, expanded]);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (focusedId && !visible.find((r) => r.id === focusedId)) {
      setFocusedId(visible[0]?.id ?? null);
    } else if (!focusedId && visible.length > 0) {
      setFocusedId(visible[0].id);
    }
  }, [visible, focusedId]);

  const moveFocus = useCallback((id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const expandKeyFor = (row: FlatRow): string | null => {
    if (row.kind === "repo") return row.repo.fullName;
    if (row.kind === "section" && row.section) return sectionKey(row.repo.fullName, row.section);
    return null;
  };

  const activate = useCallback((row: FlatRow) => {
    if (row.kind === "leaf" && row.section && row.leaf) {
      select(row.repo.fullName, row.section, row.leaf);
      return;
    }
    const key = expandKeyFor(row);
    if (key) toggleExpand(key);
  }, [select, toggleExpand]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!focusedId) return;
      const idx = visible.findIndex((r) => r.id === focusedId);
      if (idx < 0) return;
      const row = visible[idx];

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = visible[Math.min(idx + 1, visible.length - 1)];
        if (next) moveFocus(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = visible[Math.max(idx - 1, 0)];
        if (prev) moveFocus(prev.id);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const key = expandKeyFor(row);
        if (key && !expanded.has(key)) toggleExpand(key);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (row.kind === "leaf" && row.section) {
          moveFocus(`s:${sectionKey(row.repo.fullName, row.section)}`);
        } else if (row.kind === "section") {
          moveFocus(`r:${row.repo.fullName}`);
        } else if (row.kind === "repo" && expanded.has(row.repo.fullName)) {
          toggleExpand(row.repo.fullName);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(row);
      } else if (e.key === "Home") {
        e.preventDefault();
        if (visible[0]) moveFocus(visible[0].id);
      } else if (e.key === "End") {
        e.preventDefault();
        const last = visible[visible.length - 1];
        if (last) moveFocus(last.id);
      }
    },
    [focusedId, visible, expanded, moveFocus, toggleExpand, activate],
  );

  return (
    <nav
      className="shell-sidebar"
      data-collapsed={sidebarCollapsed || undefined}
      aria-label="Repository explorer"
    >
      <div className="shell-sidebar-header">
        {!sidebarCollapsed && <span className="shell-sidebar-title">EXPLORER</span>}
        <button
          type="button"
          className="shell-sidebar-toggle"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <SidebarExpandIcon size={14} /> : <ChevronLeftIcon size={14} />}
        </button>
      </div>
      <ul role="tree" className="shell-tree" onKeyDown={onKeyDown}>
        {visible.map((row, idx) => {
          const key = expandKeyFor(row);
          const isExpanded = key ? expanded.has(key) : undefined;
          const isFocused = focusedId === row.id;
          const tabIndex = isFocused ? 0 : -1;
          const isSelected =
            row.kind === "leaf" &&
            selection?.repo === row.repo.fullName &&
            selection.section === row.section &&
            selection.leaf === row.leaf;

          if (row.kind === "repo") {
            return (
              <li
                key={row.id}
                ref={(el) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); }}
                role="treeitem"
                aria-level={1}
                aria-expanded={(row.repo.hasGithub || row.repo.hasBeads) ? isExpanded : undefined}
                aria-posinset={idx + 1}
                aria-setsize={visible.length}
                tabIndex={tabIndex}
                className="shell-row shell-row-repo"
                onFocus={() => setFocusedId(row.id)}
                onClick={() => { setFocusedId(row.id); activate(row); }}
              >
                <span className="shell-chevron" aria-hidden="true" data-expanded={isExpanded || undefined}>
                  <ChevronRightIcon size={12} />
                </span>
                <RepoIcon size={12} className="shell-leaf-icon" />
                <span className="shell-repo-name">{row.repo.displayName}</span>
                <span
                  className="shell-activity-dot"
                  aria-hidden="true"
                  title={formatActivity(row.repo.lastActivityAt)}
                  style={{ background: recencyHue(row.repo.lastActivityAt) }}
                />
                {row.repo.openBeadsCount > 0 && (
                  <span className="shell-bead-count" title={`${row.repo.openBeadsCount} open beads`}>
                    {row.repo.openBeadsCount}
                  </span>
                )}
              </li>
            );
          }

          if (row.kind === "section") {
            return (
              <li
                key={row.id}
                ref={(el) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); }}
                role="treeitem"
                aria-level={2}
                aria-expanded={isExpanded}
                aria-posinset={idx + 1}
                aria-setsize={visible.length}
                tabIndex={tabIndex}
                className="shell-row shell-row-section"
                onFocus={() => setFocusedId(row.id)}
                onClick={() => { setFocusedId(row.id); activate(row); }}
              >
                <span className="shell-chevron" aria-hidden="true" data-expanded={isExpanded || undefined}>
                  <ChevronRightIcon size={11} />
                </span>
                <span className="shell-section-name">{row.section}</span>
              </li>
            );
          }

          // leaf
          const Icon = row.leaf ? leafIcon(row.leaf) : IssueOpenedIcon;
          const cnt = row.section && row.leaf ? leafCount(row.repo, row.section, row.leaf) : 0;
          return (
            <li
              key={row.id}
              ref={(el) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); }}
              role="treeitem"
              aria-level={3}
              aria-selected={isSelected}
              aria-posinset={idx + 1}
              aria-setsize={visible.length}
              tabIndex={tabIndex}
              className="shell-row shell-row-leaf"
              data-selected={isSelected || undefined}
              onFocus={() => setFocusedId(row.id)}
              onClick={() => { setFocusedId(row.id); activate(row); }}
            >
              <Icon size={11} className="shell-leaf-icon" />
              <span className="shell-leaf-label">{row.leaf}</span>
              {cnt > 0 && (
                <span className="shell-leaf-count" title={`${cnt}`}>{cnt}</span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
