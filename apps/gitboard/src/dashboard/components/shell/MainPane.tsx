// MainPane (forge-7xu). Renders the (surface, tab) view for the selected repo.

import { useMemo, useState } from "react";
import {
  useShellStore,
  selectRepos,
  selectSelection,
} from "../../stores/shell.ts";
import { useGithubStore } from "../../stores/github.ts";
import { ActivityTimeline } from "../github/ActivityTimeline.tsx";
import { PrTimeline } from "../github/PrTimeline.tsx";
import { IssueTimeline } from "../github/IssueTimeline.tsx";
import { ReleaseTimeline } from "../github/ReleaseTimeline.tsx";
import { ReadmeView, ChangelogView, ReportsView } from "../github/RepoContentPanels.tsx";
import { BeadsRepoView } from "../beads/BeadsRepoView.tsx";
import type { BeadsTab, GithubTab, RepoNode } from "../../../types/shell.ts";

export function MainPane() {
  const selection = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const setRepo = useShellStore((s) => s.setRepo);

  const repo = useMemo(
    () => (selection.repo ? repos.find((r) => r.fullName === selection.repo) ?? null : null),
    [selection.repo, repos],
  );

  if (!repo) return <EmptyState repos={repos} onPick={setRepo} surface={selection.surface} />;

  if (selection.surface === "github") {
    if (!repo.hasGithub) return <NoSide side="github" repo={repo.displayName} />;
    return <GithubTabView repo={repo} tab={selection.tab as GithubTab} />;
  }
  if (!repo.hasBeads) return <NoSide side="beads" repo={repo.displayName} />;
  return <BeadsRepoView repo={repo} tab={selection.tab as BeadsTab} />;
}

function GithubTabView({ repo, tab }: { repo: RepoNode; tab: GithubTab }) {
  const events = useGithubStore((s) => s.events);
  const prs = useGithubStore((s) => s.prs);
  const issues = useGithubStore((s) => s.issues);
  const releases = useGithubStore((s) => s.releases);
  const loading = useGithubStore((s) => s.loading);
  const error = useGithubStore((s) => s.error);

  const filtered = useMemo(() => ({
    events: events.filter((e) => e.repo === repo.fullName),
    prs: prs.filter((p) => p.repo === repo.fullName),
    issues: issues.filter((i) => i.repo === repo.fullName),
    releases: releases.filter((r) => r.repo_full_name === repo.fullName),
  }), [events, prs, issues, releases, repo.fullName]);

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  if (error) return <p className="ide-error-msg">{error}</p>;
  if (loading && events.length === 0) return <p className="ide-loading">Loading…</p>;

  const owner = repo.fullName.includes("/") ? repo.fullName.split("/")[0] : "";
  const name = repo.fullName.includes("/") ? repo.fullName.split("/")[1] : repo.fullName;

  switch (tab) {
    case "activity":
      return filtered.events.length > 0
        ? <ActivityTimeline events={filtered.events} selectedId={selectedEventId} onSelect={(e) => setSelectedEventId(e.id)} />
        : <Empty>No activity for {repo.displayName}.</Empty>;
    case "prs":
      return filtered.prs.length > 0
        ? <PrTimeline prs={filtered.prs} />
        : <Empty>No pull requests for {repo.displayName}.</Empty>;
    case "issues":
      return filtered.issues.length > 0
        ? <IssueTimeline issues={filtered.issues} />
        : <Empty>No issues for {repo.displayName}.</Empty>;
    case "releases":
      return filtered.releases.length > 0
        ? <ReleaseTimeline releases={filtered.releases} />
        : <Empty>No releases for {repo.displayName}.</Empty>;
    case "readme":
      return <ReadmeView owner={owner} name={name} />;
    case "changelog":
      return <ChangelogView owner={owner} name={name} />;
    case "reports":
      return <ReportsView owner={owner} name={name} />;
  }
}

function NoSide({ side, repo }: { side: "github" | "beads"; repo: string }) {
  return (
    <div className="ide-empty">
      <h2>No {side} data for {repo}</h2>
      <p>This repository has no {side} side attached. Pick another repo from the sidebar or switch surfaces.</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="ide-empty-msg">{children}</p>;
}

function EmptyState({
  repos, onPick, surface,
}: {
  repos: RepoNode[];
  onPick: (r: string) => void;
  surface: "github" | "beads";
}) {
  const recent = useMemo(() => {
    return [...repos]
      .filter((r) => (surface === "github" ? r.hasGithub : r.hasBeads))
      .filter((r) => r.lastActivityAt)
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
      .slice(0, 5);
  }, [repos, surface]);
  return (
    <div className="ide-empty ide-empty-state">
      <h2>Pick a {surface === "github" ? "repository" : "project"}</h2>
      <p>Pick from the sidebar, or jump into a recently active one:</p>
      <ul className="ide-empty-cards">
        {recent.map((r) => (
          <li key={r.fullName}>
            <button type="button" className="ide-empty-card" onClick={() => onPick(r.fullName)}>
              <span className="ide-empty-card-name">{r.displayName}</span>
              <span className="ide-empty-card-meta">
                {r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleDateString() : "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
