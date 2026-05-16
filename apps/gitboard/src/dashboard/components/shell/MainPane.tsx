// MainPane (forge-5w9.6 + forge-ci9 per-leaf routing).
// One full-content view per leaf — no stacked sections.

import { useMemo, useState } from "react";
import {
  useShellStore,
  selectActiveSection,
  selectRepos,
} from "../../stores/shell.ts";
import type { RepoNode } from "../../../types/shell.ts";
import { useGithubStore } from "../../stores/github.ts";
import { ActivityTimeline } from "../github/ActivityTimeline.tsx";
import { PrTimeline } from "../github/PrTimeline.tsx";
import { IssueTimeline } from "../github/IssueTimeline.tsx";
import { ReleaseTimeline } from "../github/ReleaseTimeline.tsx";
import { BeadsRepoView } from "../beads/BeadsRepoView.tsx";

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
      key={selection ? `${selection.repo}:${selection.section}:${selection.leaf}` : "empty"}
    >
      {selection && repo ? (
        <LeafView repo={repo} section={selection.section} leaf={selection.leaf} />
      ) : (
        <EmptyState />
      )}
    </main>
  );
}

function LeafView({
  repo,
  section,
  leaf,
}: {
  repo: RepoNode;
  section: "github" | "beads";
  leaf: string;
}) {
  return (
    <div className="shell-leaf-view">
      <header className="shell-crumb-bar">
        <span className="shell-crumb">{repo.displayName}</span>
        <span className="shell-crumb-sep">/</span>
        <span className="shell-crumb">{section}</span>
        <span className="shell-crumb-sep">/</span>
        <span className="shell-crumb shell-crumb-active">{leaf}</span>
      </header>
      <div className="shell-leaf-body">
        {section === "github" ? (
          repo.hasGithub ? (
            <GithubLeafView repo={repo} leaf={leaf} />
          ) : (
            <NoSideMsg side="github" repo={repo.displayName} />
          )
        ) : repo.hasBeads ? (
          <BeadsLeafView repo={repo} leaf={leaf} />
        ) : (
          <NoSideMsg side="beads" repo={repo.displayName} />
        )}
      </div>
    </div>
  );
}

function GithubLeafView({ repo, leaf }: { repo: RepoNode; leaf: string }) {
  const events = useGithubStore((s) => s.events);
  const prs = useGithubStore((s) => s.prs);
  const issues = useGithubStore((s) => s.issues);
  const releases = useGithubStore((s) => s.releases);
  const loading = useGithubStore((s) => s.loading);
  const error = useGithubStore((s) => s.error);

  const filteredEvents = useMemo(
    () => events.filter((e) => e.repo === repo.fullName),
    [events, repo.fullName],
  );
  const filteredPrs = useMemo(
    () => prs.filter((p) => p.repo === repo.fullName),
    [prs, repo.fullName],
  );
  const filteredIssues = useMemo(
    () => issues.filter((i) => i.repo === repo.fullName),
    [issues, repo.fullName],
  );
  const filteredReleases = useMemo(
    () => releases.filter((r) => r.repo_full_name === repo.fullName),
    [releases, repo.fullName],
  );

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  if (error) return <p className="shell-error-msg">{error}</p>;
  if (loading && events.length === 0) return <p className="shell-loading">Loading…</p>;

  if (leaf === "activity") {
    return filteredEvents.length > 0 ? (
      <ActivityTimeline
        events={filteredEvents}
        selectedId={selectedEventId}
        onSelect={(e) => setSelectedEventId(e.id)}
      />
    ) : (
      <Empty label="No activity recorded for this repository." />
    );
  }
  if (leaf === "prs") {
    return filteredPrs.length > 0 ? (
      <PrTimeline prs={filteredPrs} />
    ) : (
      <Empty label="No pull requests recorded for this repository." />
    );
  }
  if (leaf === "issues") {
    return filteredIssues.length > 0 ? (
      <IssueTimeline issues={filteredIssues} />
    ) : (
      <Empty label="No issues recorded for this repository." />
    );
  }
  if (leaf === "releases") {
    return filteredReleases.length > 0 ? (
      <ReleaseTimeline releases={filteredReleases} />
    ) : (
      <Empty label="No releases recorded for this repository." />
    );
  }
  return <Empty label={`Unknown github view: ${leaf}`} />;
}

function BeadsLeafView({ repo, leaf }: { repo: RepoNode; leaf: string }) {
  // BeadsRepoView already handles kanban + overlay; treat 'issues' as a wider list
  // for now (operator wanted separate pages — leaving room for a dedicated feed view).
  if (leaf === "kanban" || leaf === "issues") {
    return <BeadsRepoView repo={repo} />;
  }
  return <Empty label={`Unknown beads view: ${leaf}`} />;
}

function NoSideMsg({ side, repo }: { side: "github" | "beads"; repo: string }) {
  return (
    <div className="shell-main-empty">
      <h2 className="shell-main-empty-title">No /{side} data for /{repo}</h2>
      <p className="shell-main-empty-hint">
        This repository has no {side} side attached. Pick another leaf from the sidebar.
      </p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="shell-github-empty">{label}</p>;
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
        Expand a repo in the sidebar, then pick <code>activity</code>, <code>pull-requests</code>, <code>issues</code>, <code>releases</code>, or <code>kanban</code>.
      </p>
      <ul className="shell-main-empty-cards">
        {recent.map((r) => (
          <li key={r.fullName} className="shell-main-empty-card">
            <button
              type="button"
              className="shell-main-empty-card-btn"
              onClick={() =>
                select(
                  r.fullName,
                  r.hasGithub ? "github" : "beads",
                  r.hasGithub ? "activity" : "kanban",
                )
              }
            >
              <span className="shell-main-empty-card-name">{r.displayName}</span>
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
