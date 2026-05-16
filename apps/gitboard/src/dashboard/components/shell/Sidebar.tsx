// File-tree Sidebar (forge-5w9.4). VS Code-style: chevron + indent guide,
// compact 22px rows, octicon chips with counts, ARIA tree semantics,
// keyboard navigation (Up/Down/Left/Right/Home/End/Enter).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  GitPullRequestIcon,
  GitCommitIcon,
  IssueOpenedIcon,
  TagIcon,
  MilestoneIcon,
  SyncIcon,
  AlertIcon,
} from "@primer/octicons-react";
import {
  useShellStore,
  selectRepos,
  selectExpanded,
  selectActiveSection,
} from "../../stores/shell.ts";
import type { RepoNode, RepoSection } from "../../../types/shell.ts";

type RowKind = "repo" | "child";
interface FlatRow {
  kind: RowKind;
  repo: RepoNode;
  section?: RepoSection;       // child rows only
  level: 1 | 2;
  id: string;                   // dom + aria key
}

function buildVisibleRows(repos: RepoNode[], expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const repo of repos) {
    rows.push({ kind: "repo", repo, level: 1, id: `r:${repo.fullName}` });
    if (expanded.has(repo.fullName)) {
      if (repo.hasGithub) {
        rows.push({ kind: "child", repo, section: "github", level: 2, id: `c:${repo.fullName}:github` });
      }
      if (repo.hasBeads) {
        rows.push({ kind: "child", repo, section: "beads", level: 2, id: `c:${repo.fullName}:beads` });
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
  const date = new Date(iso);
  return `last activity ${date.toLocaleString()}`;
}

interface ChipDef {
  icon: typeof IssueOpenedIcon;
  count: number;
  label: string;
}

function githubChips(repo: RepoNode): ChipDef[] {
  const g = repo.githubStats;
  return [
    { icon: GitPullRequestIcon, count: g.openPRs, label: `${g.openPRs} open PRs` },
    { icon: GitCommitIcon, count: g.commitsToday, label: `${g.commitsToday} commits today` },
    { icon: IssueOpenedIcon, count: g.openIssues, label: `${g.openIssues} open issues` },
    { icon: TagIcon, count: g.releases, label: `${g.releases} releases` },
  ].filter((c) => c.count > 0);
}

function beadsChips(repo: RepoNode): ChipDef[] {
  const b = repo.beadsStats;
  return [
    { icon: IssueOpenedIcon, count: b.open, label: `${b.open} open` },
    { icon: SyncIcon, count: b.inProgress, label: `${b.inProgress} in progress` },
    { icon: AlertIcon, count: b.blocked, label: `${b.blocked} blocked` },
    { icon: MilestoneIcon, count: b.epics, label: `${b.epics} epics` },
  ].filter((c) => c.count > 0);
}

export function Sidebar() {
  const repos = useShellStore(selectRepos);
  const expanded = useShellStore(selectExpanded);
  const selection = useShellStore(selectActiveSection);
  const toggleExpand = useShellStore((s) => s.toggleExpand);
  const select = useShellStore((s) => s.select);
  const sidebarCollapsed = useShellStore((s) => s.sidebarCollapsed);

  const visible = useMemo(() => buildVisibleRows(repos, expanded), [repos, expanded]);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Keep focusedId valid as visibility changes
  useEffect(() => {
    if (focusedId && !visible.find((r) => r.id === focusedId)) {
      setFocusedId(visible[0]?.id ?? null);
    } else if (!focusedId && visible.length > 0) {
      setFocusedId(visible[0].id);
    }
  }, [visible, focusedId]);

  // Focus DOM when focusedId changes due to keyboard
  const moveFocus = useCallback((id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

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
        if (row.kind === "repo" && !expanded.has(row.repo.fullName)) {
          toggleExpand(row.repo.fullName);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (row.kind === "child") {
          moveFocus(`r:${row.repo.fullName}`);
        } else if (row.kind === "repo" && expanded.has(row.repo.fullName)) {
          toggleExpand(row.repo.fullName);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (row.kind === "repo") {
          toggleExpand(row.repo.fullName);
        } else if (row.section) {
          select(row.repo.fullName, row.section);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        if (visible[0]) moveFocus(visible[0].id);
      } else if (e.key === "End") {
        e.preventDefault();
        const last = visible[visible.length - 1];
        if (last) moveFocus(last.id);
      }
    },
    [focusedId, visible, expanded, moveFocus, toggleExpand, select],
  );

  return (
    <nav
      className="shell-sidebar"
      data-collapsed={sidebarCollapsed || undefined}
      aria-label="Repository explorer"
    >
      <div className="shell-sidebar-header">
        <span className="shell-sidebar-title">EXPLORER</span>
      </div>
      <ul role="tree" className="shell-tree" onKeyDown={onKeyDown}>
        {visible.map((row, idx) => {
          const isExpanded = row.kind === "repo" && expanded.has(row.repo.fullName);
          const isSelected =
            row.kind === "child" &&
            selection?.repo === row.repo.fullName &&
            selection.section === row.section;
          const isFocused = focusedId === row.id;
          const tabIndex = isFocused ? 0 : -1;

          if (row.kind === "repo") {
            return (
              <li
                key={row.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.id, el);
                  else rowRefs.current.delete(row.id);
                }}
                role="treeitem"
                aria-level={1}
                aria-expanded={row.repo.hasGithub || row.repo.hasBeads ? isExpanded : undefined}
                aria-posinset={idx + 1}
                aria-setsize={visible.length}
                tabIndex={tabIndex}
                className="shell-row shell-row-repo"
                onFocus={() => setFocusedId(row.id)}
                onClick={() => {
                  setFocusedId(row.id);
                  toggleExpand(row.repo.fullName);
                }}
              >
                <span className="shell-chevron" aria-hidden="true" data-expanded={isExpanded || undefined}>
                  <ChevronRightIcon size={12} />
                </span>
                <span className="shell-repo-name">/{row.repo.displayName}</span>
                <span
                  className="shell-activity-dot"
                  aria-hidden="true"
                  title={formatActivity(row.repo.lastActivityAt)}
                  style={{ background: recencyHue(row.repo.lastActivityAt) }}
                />
                {row.repo.openBeadsCount > 0 && (
                  <span
                    className="shell-bead-count"
                    title={`${row.repo.openBeadsCount} open beads`}
                  >
                    {row.repo.openBeadsCount}
                  </span>
                )}
              </li>
            );
          }

          const chips =
            row.section === "github" ? githubChips(row.repo) : beadsChips(row.repo);
          return (
            <li
              key={row.id}
              ref={(el) => {
                if (el) rowRefs.current.set(row.id, el);
                else rowRefs.current.delete(row.id);
              }}
              role="treeitem"
              aria-level={2}
              aria-selected={isSelected}
              aria-posinset={idx + 1}
              aria-setsize={visible.length}
              tabIndex={tabIndex}
              className="shell-row shell-row-child"
              data-selected={isSelected || undefined}
              onFocus={() => setFocusedId(row.id)}
              onClick={() => {
                setFocusedId(row.id);
                if (row.section) select(row.repo.fullName, row.section);
              }}
            >
              <span className="shell-row-rail" aria-hidden="true" />
              <span className="shell-child-label">/{row.section}</span>
              <span className="shell-chips" aria-hidden="true">
                {chips.map((c, i) => {
                  const Icon = c.icon;
                  return (
                    <span key={i} className="shell-chip" title={c.label}>
                      <Icon size={11} />
                      <span className="shell-chip-count">{c.count}</span>
                    </span>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
