// MainPane (forge-gud9). Renders selected repo surface plus bottom drawer.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShellStore, selectRepos, selectSelection } from "../../stores/shell.ts";
import { useGithubStore } from "../../stores/github.ts";
import { apiClient } from "../../lib/client.ts";
import { ActivityTimeline } from "../github/ActivityTimeline.tsx";
import { PrTimeline } from "../github/PrTimeline.tsx";
import { IssueTimeline } from "../github/IssueTimeline.tsx";
import { ReleaseTimeline } from "../github/ReleaseTimeline.tsx";
import { ReadmeView, ChangelogView, ReportsView } from "../github/RepoContentPanels.tsx";
import { BeadsRepoView } from "../beads/BeadsRepoView.tsx";
import { Graph } from "../../pages/console/Graph.tsx";
import { Observability } from "../../pages/console/Observability.tsx";
import { Specialists } from "../../pages/console/Specialists.tsx";
import { Operations } from "../../pages/console/Operations.tsx";
import { Explore } from "../../pages/console/Explore.tsx";
import { BottomDrawer } from "./BottomDrawer.tsx";
import type { GithubTab, RepoNode } from "../../../types/shell.ts";
import type { GithubEvent, GithubPr, GithubIssue, GithubRelease } from "../../../types/github.ts";

export function MainPane() {
  const selection = useShellStore(selectSelection);
  const repos = useShellStore(selectRepos);
  const setRepo = useShellStore((s) => s.setRepo);
  const setDrawerOpen = useShellStore((s) => s.setDrawerOpen);
  const lastSelectedRepoRef = useRef<RepoNode | null>(null);

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

  const matchedRepo = useMemo(() => (selection.repo ? repos.find((r) => r.fullName === selection.repo) ?? null : null), [selection.repo, repos]);
  const cachedRepo = selection.repo && lastSelectedRepoRef.current?.fullName === selection.repo ? lastSelectedRepoRef.current : null;
  const repo = matchedRepo ?? cachedRepo;

  useEffect(() => {
    if (matchedRepo) lastSelectedRepoRef.current = matchedRepo;
  }, [matchedRepo]);

  useEffect(() => {
    if (selection.surface !== "github") return;
    if (!["activity", "prs", "issues", "releases"].includes(selection.tab)) return;
    performance.mark(`tab_switch:${selection.tab}:start`);
  }, [selection.surface, selection.tab]);

  let inner: ReactNode;
  if (selection.surface === "github") {
    inner = !repo ? <EmptyState repos={repos} onPick={setRepo} surface="github" /> : repo.hasGithub ? <GithubTabView repo={repo} tab={selection.tab as GithubTab} /> : <NoSide side="github" repo={repo.displayName} />;
  } else {
    switch (selection.tab) {
      case "feed":
      case "triage":
      case "memories":
        inner = !repo ? <EmptyState repos={repos} onPick={setRepo} surface="beads" /> : repo.hasBeads ? <BeadsRepoView repo={repo} tab={selection.tab} /> : <NoSide side="beads" repo={repo.displayName} />;
        break;
      case "graph":
        inner = <Graph />;
        break;
      case "observability":
        inner = <Observability />;
        break;
      case "specialists":
        inner = <Specialists />;
        break;
      case "operations":
        inner = <Operations />;
        break;
      case "explore":
        inner = <Explore />;
        break;
      default:
        inner = <Observability />;
    }
  }

  return (
    <main className="ide-main shell-main" key={`${selection.surface}:${selection.repo ?? ""}`}>
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
  loadedTabs: Partial<Record<GithubDataTab, boolean>>;
  loadingTabs: Partial<Record<GithubDataTab, boolean>>;
}

type GithubDataTab = "activity" | "prs" | "issues" | "releases";

const githubRepoCache = new Map<string, GithubRepoData>();
const dataTabs = new Set<GithubTab>(["activity", "prs", "issues", "releases"]);
const emptyGithubRepoData = (): GithubRepoData => ({ loading: false, error: null, events: [], prs: [], issues: [], releases: [], loadedTabs: {}, loadingTabs: {} });

function isDataTab(tab: GithubTab): tab is GithubDataTab {
  return dataTabs.has(tab);
}

function eventTime(event: GithubEvent): string {
  return event.created_at ?? "";
}

function prTime(pr: GithubPr): string {
  return pr.updated_at ?? pr.created_at ?? "";
}

function issueTime(issue: GithubIssue): string {
  return issue.updated_at ?? issue.created_at ?? "";
}

function releaseTime(release: GithubRelease): string {
  return release.published_at ?? "";
}

function mergeEvents(current: GithubEvent[], incoming: GithubEvent[]): GithubEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    const existing = byId.get(event.id);
    if (!existing || eventTime(event) >= eventTime(existing)) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => eventTime(b).localeCompare(eventTime(a))).slice(0, 200);
}

function mergePrs(current: GithubPr[], incoming: GithubPr[]): GithubPr[] {
  const byKey = new Map(current.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
  for (const pr of incoming) {
    const key = `${pr.repo}#${pr.number}`;
    const existing = byKey.get(key);
    if (!existing || prTime(pr) >= prTime(existing)) byKey.set(key, pr);
  }
  return [...byKey.values()].sort((a, b) => prTime(b).localeCompare(prTime(a)));
}

function mergeIssues(current: GithubIssue[], incoming: GithubIssue[]): GithubIssue[] {
  const byKey = new Map(current.map((issue) => [`${issue.repo}#${issue.number}`, issue]));
  for (const issue of incoming) {
    const key = `${issue.repo}#${issue.number}`;
    const existing = byKey.get(key);
    if (!existing || issueTime(issue) >= issueTime(existing)) byKey.set(key, issue);
  }
  return [...byKey.values()].sort((a, b) => issueTime(b).localeCompare(issueTime(a)));
}

function mergeReleases(current: GithubRelease[], incoming: GithubRelease[]): GithubRelease[] {
  const byKey = new Map(current.map((release) => [`${release.repo_full_name}#${release.tag_name}`, release]));
  for (const release of incoming) {
    const key = `${release.repo_full_name}#${release.tag_name}`;
    const existing = byKey.get(key);
    if (!existing || releaseTime(release) >= releaseTime(existing)) byKey.set(key, release);
  }
  return [...byKey.values()].sort((a, b) => releaseTime(b).localeCompare(releaseTime(a)));
}

function cacheForRepo(fullName: string): GithubRepoData {
  const cached = githubRepoCache.get(fullName);
  if (cached) return cached;
  const empty = emptyGithubRepoData();
  githubRepoCache.set(fullName, empty);
  return empty;
}

function updateCache(fullName: string, updater: (current: GithubRepoData) => GithubRepoData): GithubRepoData {
  const next = updater(cacheForRepo(fullName));
  githubRepoCache.set(fullName, next);
  return next;
}

function mergeRepoData(current: GithubRepoData, next: GithubRepoData): GithubRepoData {
  return {
    ...current,
    ...next,
    events: mergeEvents(current.events, next.events),
    prs: mergePrs(current.prs, next.prs),
    issues: mergeIssues(current.issues, next.issues),
    releases: mergeReleases(current.releases, next.releases),
    loadedTabs: { ...current.loadedTabs, ...next.loadedTabs },
    loadingTabs: { ...current.loadingTabs, ...next.loadingTabs },
  };
}

function useGithubRepoData(fullName: string, tab: GithubTab): GithubRepoData {
  const storeEvents = useGithubStore((s) => s.events);
  const storePrs = useGithubStore((s) => s.prs);
  const storeIssues = useGithubStore((s) => s.issues);
  const storeReleases = useGithubStore((s) => s.releases);
  const liveEvents = useMemo(() => storeEvents.filter((event) => event.repo === fullName), [storeEvents, fullName]);
  const livePrs = useMemo(() => storePrs.filter((pr) => pr.repo === fullName), [storePrs, fullName]);
  const liveIssues = useMemo(() => storeIssues.filter((issue) => issue.repo === fullName), [storeIssues, fullName]);
  const liveReleases = useMemo(() => storeReleases.filter((release) => release.repo_full_name === fullName), [storeReleases, fullName]);
  const [state, setState] = useState<GithubRepoData>(() => mergeRepoData(cacheForRepo(fullName), { ...emptyGithubRepoData(), events: liveEvents, prs: livePrs, issues: liveIssues, releases: liveReleases }));

  useEffect(() => {
    setState(updateCache(fullName, (current) => mergeRepoData(current, {
      ...emptyGithubRepoData(),
      events: liveEvents,
      prs: livePrs,
      issues: liveIssues,
      releases: liveReleases,
    })));
  }, [fullName, liveEvents, livePrs, liveIssues, liveReleases]);

  useEffect(() => {
    if (!isDataTab(tab)) return;

    let cancelled = false;
    const hasCachedData = cacheForRepo(fullName).loadedTabs[tab];
    setState(updateCache(fullName, (current) => {
      const currentWithLiveRows = mergeRepoData(current, {
        ...emptyGithubRepoData(),
        events: liveEvents,
        prs: livePrs,
        issues: liveIssues,
        releases: liveReleases,
      });
      return {
        ...currentWithLiveRows,
        error: null,
        loadingTabs: { ...currentWithLiveRows.loadingTabs, [tab]: true },
        loading: !hasCachedData,
      };
    }));

    const apply = (updater: (current: GithubRepoData) => GithubRepoData) => {
      if (cancelled) return;
      setState(updateCache(fullName, updater));
    };

    const finishError = (err: unknown) => apply((current) => ({
      ...current,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      loadingTabs: { ...current.loadingTabs, [tab]: false },
    }));

    if (tab === "activity") {
      apiClient.getEvents({ repos: [fullName], limit: 200 })
        .then((response) => apply((current) => ({ ...current, loading: false, error: null, events: mergeEvents(current.events, response.data ?? []), loadedTabs: { ...current.loadedTabs, activity: true }, loadingTabs: { ...current.loadingTabs, activity: false } })))
        .catch(finishError);
    }
    if (tab === "prs") {
      apiClient.getPrs({ repo: fullName, limit: 200 })
        .then((response) => apply((current) => ({ ...current, loading: false, error: null, prs: mergePrs(current.prs, response.data ?? []), loadedTabs: { ...current.loadedTabs, prs: true }, loadingTabs: { ...current.loadingTabs, prs: false } })))
        .catch(finishError);
    }
    if (tab === "issues") {
      apiClient.getIssues({ repo: fullName, limit: 200 })
        .then((response) => apply((current) => ({ ...current, loading: false, error: null, issues: mergeIssues(current.issues, response.data ?? []), loadedTabs: { ...current.loadedTabs, issues: true }, loadingTabs: { ...current.loadingTabs, issues: false } })))
        .catch(finishError);
    }
    if (tab === "releases") {
      apiClient.getReleases({ repo: fullName, limit: 50 })
        .then((response) => apply((current) => ({ ...current, loading: false, error: null, releases: mergeReleases(current.releases, response.releases ?? []), loadedTabs: { ...current.loadedTabs, releases: true }, loadingTabs: { ...current.loadingTabs, releases: false } })))
        .catch(finishError);
    }

    return () => { cancelled = true; };
  }, [fullName, tab]);

  return state;
}

function GithubTabView({ repo, tab }: { repo: RepoNode; tab: GithubTab }) {
  const data = useGithubRepoData(repo.fullName, tab);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    if (!isGithubDataTab(tab)) return;
    if (data.loading || data.loadingTabs[tab]) return;
    const startMark = `tab_switch:${tab}:start`;
    const renderedMark = `tab_switch:${tab}:rendered`;
    performance.mark(renderedMark);
    try {
      performance.measure(`tab_switch:${tab}`, startMark, renderedMark);
    } catch {
      // mark missing or duplicate, ignore
    }
  }, [data.loading, data.loadingTabs, tab, data.events.length, data.prs.length, data.issues.length, data.releases.length]);

  const hasVisibleData = (tab === "activity" && data.events.length > 0)
    || (tab === "prs" && data.prs.length > 0)
    || (tab === "issues" && data.issues.length > 0)
    || (tab === "releases" && data.releases.length > 0);
  if (data.error && !hasVisibleData) return <p className="ide-error-msg">{data.error}</p>;
  const owner = repo.fullName.includes("/") ? repo.fullName.split("/")[0] : "";
  const name = repo.fullName.includes("/") ? repo.fullName.split("/")[1] : repo.fullName;

  switch (tab) {
    case "activity": return data.events.length > 0 ? <ActivityTimeline events={data.events} selectedId={selectedEventId} onSelect={(e) => setSelectedEventId(e.id)} /> : data.loadingTabs.activity ? <p className="ide-loading">Loading activity…</p> : <Empty>No activity for {repo.displayName}.</Empty>;
    case "prs": return data.prs.length > 0 ? <PrTimeline prs={data.prs} /> : data.loadingTabs.prs ? <p className="ide-loading">Loading prs…</p> : <Empty>No pull requests for {repo.displayName}.</Empty>;
    case "issues": return data.issues.length > 0 ? <IssueTimeline issues={data.issues} /> : data.loadingTabs.issues ? <p className="ide-loading">Loading issues…</p> : <Empty>No issues for {repo.displayName}.</Empty>;
    case "releases": return data.releases.length > 0 ? <ReleaseTimeline releases={data.releases} /> : data.loadingTabs.releases ? <p className="ide-loading">Loading releases…</p> : <Empty>No releases for {repo.displayName}.</Empty>;
    case "readme": return <ReadmeView owner={owner} name={name} />;
    case "changelog": return <ChangelogView owner={owner} name={name} />;
    case "reports": return <ReportsView owner={owner} name={name} />;
  }
}

function NoSide({ side, repo }: { side: "github" | "beads"; repo: string }) {
  return <div className="ide-empty"><h2>No {side} data for {repo}</h2><p>This repository has no {side} side attached. Pick another repo from sidebar or switch surfaces.</p></div>;
}

function Empty({ children }: { children: ReactNode }) { return <p className="ide-empty-msg">{children}</p>; }

function isGithubDataTab(tab: GithubTab): tab is GithubDataTab {
  return tab === "activity" || tab === "prs" || tab === "issues" || tab === "releases";
}

function EmptyState({ repos, onPick, surface }: { repos: RepoNode[]; onPick: (r: string) => void; surface: "github" | "beads"; }) {
  const recent = useMemo(() => [...repos].filter((r) => (surface === "github" ? r.hasGithub : r.hasBeads)).filter((r) => r.lastActivityAt).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "")).slice(0, 5), [repos, surface]);
  return <div className="ide-empty ide-empty-state"><h2>Pick a {surface === "github" ? "repository" : "project"}</h2><p>Pick from sidebar, or jump into recently active one:</p><ul className="ide-empty-cards">{recent.map((r) => <li key={r.fullName}><button type="button" className="ide-empty-card" onClick={() => onPick(r.fullName)}><span className="ide-empty-card-name">{r.displayName}</span><span className="ide-empty-card-meta">{r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleDateString() : "—"}</span></button></li>)}</ul></div>;
}
