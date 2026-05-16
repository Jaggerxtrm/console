// MainPane swap (forge-5w9.6). Reads selection from useShellStore.
// section==='github' → GithubRepoView (stub; filled in 5w9.8).
// section==='beads'  → BeadsRepoView  (stub; filled in 5w9.7).
// selection===null   → EmptyState with recent-repo cards.

import { useMemo } from "react";
import {
  useShellStore,
  selectActiveSection,
  selectRepos,
} from "../../stores/shell.ts";
import type { RepoNode } from "../../../types/shell.ts";
import { BeadsRepoView } from "../beads/BeadsRepoView.tsx";

function StubView({ repo, section }: { repo: RepoNode; section: "github" | "beads" }) {
  const sections =
    section === "github"
      ? ["Recent activity", "Pull requests", "Issues", "Releases"]
      : ["Kanban", "Open issues", "Memories"];
  return (
    <div className="shell-main-stub">
      <header className="shell-main-stub-header">
        <span className="shell-main-stub-crumb">/{repo.displayName}</span>
        <span className="shell-main-stub-crumb-sep">·</span>
        <span className="shell-main-stub-crumb shell-main-stub-crumb-active">/{section}</span>
      </header>
      <ul className="shell-main-stub-list">
        {sections.map((s) => (
          <li key={s} className="shell-main-stub-section">
            <span className="shell-main-stub-section-title">{s}</span>
            <span className="shell-main-stub-section-note">
              wired in forge-5w9.{section === "github" ? "8" : "7"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoSideMsg({ side, repo }: { side: "github" | "beads"; repo: string }) {
  return (
    <div className="shell-main-empty">
      <h2 className="shell-main-empty-title">No /{side} data for /{repo}</h2>
      <p className="shell-main-empty-hint">
        This repository has no {side} side attached. Pick another section from the sidebar.
      </p>
    </div>
  );
}

function EmptyState() {
  const repos = useShellStore(selectRepos);
  const select = useShellStore((s) => s.select);
  const recent = useMemo(() => {
    return [...repos]
      .filter((r) => r.lastActivityAt)
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
      .slice(0, 3);
  }, [repos]);

  return (
    <div className="shell-main-empty">
      <h2 className="shell-main-empty-title">Pick a repository</h2>
      <p className="shell-main-empty-hint">
        Use the sidebar to pick <code>/github</code> or <code>/beads</code> for any repo. Recently active:
      </p>
      <ul className="shell-main-empty-cards">
        {recent.map((r) => (
          <li key={r.fullName} className="shell-main-empty-card">
            <button
              type="button"
              className="shell-main-empty-card-btn"
              onClick={() => select(r.fullName, r.hasGithub ? "github" : "beads")}
            >
              <span className="shell-main-empty-card-name">/{r.displayName}</span>
              <span className="shell-main-empty-card-meta">
                {r.openBeadsCount > 0 ? `${r.openBeadsCount} open beads` : "no open beads"}
                {r.lastActivityAt ? ` · ${new Date(r.lastActivityAt).toLocaleDateString()}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MainPane() {
  const selection = useShellStore(selectActiveSection);
  const repos = useShellStore(selectRepos);

  const repo = useMemo(
    () => (selection ? repos.find((r) => r.fullName === selection.repo) : null),
    [selection, repos],
  );

  return (
    <main
      className="shell-main"
      // Per-(repo,section) key forces a clean view on swap. State preservation
      // (scroll, expanded rows) is a 5w9.6 follow-up — V1 trades it for simplicity.
      key={selection ? `${selection.repo}:${selection.section}` : "empty"}
    >
      {selection && repo ? (
        selection.section === "beads" ? (
          repo.hasBeads ? (
            <BeadsRepoView repo={repo} />
          ) : (
            <NoSideMsg side="beads" repo={repo.displayName} />
          )
        ) : (
          <StubView repo={repo} section={selection.section} />
        )
      ) : (
        <EmptyState />
      )}
    </main>
  );
}
