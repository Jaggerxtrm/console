// MainPane (forge-gud9). Renders selected repo surface plus bottom drawer.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShellStore, selectRepos, selectSelection } from "../../stores/shell.ts";
import { apiClient } from "../../lib/client.ts";
import { ActivityTimeline } from "../github/ActivityTimeline.tsx";
import { PrTimeline } from "../github/PrTimeline.tsx";
import { IssueTimeline } from "../github/IssueTimeline.tsx";
import { ReleaseTimeline } from "../github/ReleaseTimeline.tsx";
import { ReadmeView, ChangelogView, ReportsView } from "../github/RepoContentPanels.tsx";
import { BeadsRepoView } from "../beads/BeadsRepoView.tsx";
import { Observability } from "../../pages/console/Observability.tsx";
import { BottomDrawer } from "./BottomDrawer.tsx";
import type { BeadsTab, GithubTab, RepoNode } from "../../../types/shell.ts";
import type { GithubEvent, GithubPr, GithubIssue, GithubRelease } from "../../../types/github.ts";

export function MainPane() {
  const selection = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const setRepo = useShellStore((s) => s.setRepo);
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setDrawerOpen(!useShellStore.getState().drawerOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setDrawerOpen]);

  const repo = useMemo(() => (selection.repo ? repos.find((r) => r.fullName === selection.repo) ?? null : null), [selection.repo, repos]);

  let inner: ReactNode;
  if (selection.surface === "console") {
    inner = <Observability />;
  } else if (!repo) {
    inner = <EmptyState repos={repos} onPick={setRepo} surface={selection.surface} />;
  } else if (selection.surface === "github") {
    inner = repo.hasGithub ? <GithubTabView repo={repo} tab={selection.tab as GithubTab} /> : <NoSide side="github" repo={repo.displayName} />;
  } else {
    inner = repo.hasBeads ? <BeadsRepoView repo={repo} tab={selection.tab as BeadsTab} /> : <NoSide side="beads" repo={repo.displayName} />;
  }

  return (
    <main className="ide-main shell-main" key={`${selection.surface}:${selection.tab}:${selection.repo ?? ""}`}>
      <div className="ide-main-content">{inner}</div>
      <BottomDrawer />
    </main>
  );
}

interface GithubRepoData {
  loading: boolean;
  error: string | null;
  events: GithubEvent[];
  prs: GithubPr[];
  issues: GithubIssue[];
  releases: GithubRelease[];
}

function useGithubRepoData(fullName: string): GithubRepoData {
  const [state, setState] = useState<GithubRepoData>({ loading: true, error: null, events: [], prs: [], issues: [], releases: [] });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.all([
      apiClient.getEvents({ repos: [fullName], limit: 200 }).catch(() => ({ data: [] as GithubEvent[] })),
      apiClient.getPrs({ repo: fullName, limit: 200 }).catch(() => ({ data: [] as GithubPr[] })),
      apiClient.getIssues({ repo: fullName, limit: 200 }).catch(() => ({ data: [] as GithubIssue[] })),
      apiClient.getReleases({ repo: fullName, limit: 50 }).catch(() => ({ releases: [] as GithubRelease[] })),
    ]).then(([ev, pr, is, rel]) => {
      if (cancelled) return;
      setState({ loading: false, error: null, events: ev.data ?? [], prs: pr.data ?? [], issues: is.data ?? [], releases: rel.releases ?? [] });
    }).catch((err) => {
      if (cancelled) return;
      setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
    });
    return () => { cancelled = true; };
  }, [fullName]);

  return state;
}

function GithubTabView({ repo, tab }: { repo: RepoNode; tab: GithubTab }) {
  const data = useGithubRepoData(repo.fullName);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  if (data.error) return <p className="ide-error-msg">{data.error}</p>;
  if (data.loading) return <p className="ide-loading">Loading {tab}…</p>;
  const owner = repo.fullName.includes("/") ? repo.fullName.split("/")[0] : "";
  const name = repo.fullName.includes("/") ? repo.fullName.split("/")[1] : repo.fullName;

  switch (tab) {
    case "activity": return data.events.length > 0 ? <ActivityTimeline events={data.events} selectedId={selectedEventId} onSelect={(e) => setSelectedEventId(e.id)} /> : <Empty>No activity for {repo.displayName}.</Empty>;
    case "prs": return data.prs.length > 0 ? <PrTimeline prs={data.prs} /> : <Empty>No pull requests for {repo.displayName}.</Empty>;
    case "issues": return data.issues.length > 0 ? <IssueTimeline issues={data.issues} /> : <Empty>No issues for {repo.displayName}.</Empty>;
    case "releases": return data.releases.length > 0 ? <ReleaseTimeline releases={data.releases} /> : <Empty>No releases for {repo.displayName}.</Empty>;
    case "readme": return <ReadmeView owner={owner} name={name} />;
    case "changelog": return <ChangelogView owner={owner} name={name} />;
    case "reports": return <ReportsView owner={owner} name={name} />;
  }
}

function NoSide({ side, repo }: { side: "github" | "beads"; repo: string }) {
  return <div className="ide-empty"><h2>No {side} data for {repo}</h2><p>This repository has no {side} side attached. Pick another repo from sidebar or switch surfaces.</p></div>;
}

function Empty({ children }: { children: ReactNode }) { return <p className="ide-empty-msg">{children}</p>; }

function EmptyState({ repos, onPick, surface }: { repos: RepoNode[]; onPick: (r: string) => void; surface: "github" | "beads"; }) {
  const recent = useMemo(() => [...repos].filter((r) => (surface === "github" ? r.hasGithub : r.hasBeads)).filter((r) => r.lastActivityAt).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")).slice(0, 5), [repos, surface]);
  return <div className="ide-empty ide-empty-state"><h2>Pick a {surface === "github" ? "repository" : "project"}</h2><p>Pick from sidebar, or jump into recently active one:</p><ul className="ide-empty-cards">{recent.map((r) => <li key={r.fullName}><button type="button" className="ide-empty-card" onClick={() => onPick(r.fullName)}><span className="ide-empty-card-name">{r.displayName}</span><span className="ide-empty-card-meta">{r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleDateString() : "—"}</span></button></li>)}</ul></div>;
}
