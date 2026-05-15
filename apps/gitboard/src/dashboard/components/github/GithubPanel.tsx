import { useState } from "react";
import { StarIcon } from "@primer/octicons-react";
import { useGithubStore } from "../../stores/github.ts";
import { useGithubActivity } from "../../hooks/useGithubActivity.ts";
import { StatsHeader } from "./StatsHeader.tsx";
import { RepoSidebar } from "./RepoSidebar.tsx";
import { ActivityTimeline } from "./ActivityTimeline.tsx";
import { PrTimeline } from "./PrTimeline.tsx";
import { IssueTimeline } from "./IssueTimeline.tsx";
import { ReleaseTimeline } from "./ReleaseTimeline.tsx";
import { RepoDossier } from "./RepoDossier.tsx";
import type { GithubEvent } from "../../../types/github.ts";

const SOCIAL_TYPES = new Set(["WatchEvent", "ForkEvent", "MemberEvent"]);

type Tab = "activity" | "prs" | "issues" | "releases";

function TabBar({
  activeTab,
  onSelect,
  prCount,
  issueCount,
  releaseCount,
}: {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  prCount: number;
  issueCount: number;
  releaseCount: number;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "activity", label: "Activity" },
    { id: "prs", label: `Pull Requests${prCount > 0 ? ` (${prCount})` : ""}` },
    { id: "issues", label: `Issues${issueCount > 0 ? ` (${issueCount})` : ""}` },
    { id: "releases", label: `Releases${releaseCount > 0 ? ` (${releaseCount})` : ""}` },
  ];

  return (
    <div
      className="gitboard-tabbar"
      style={{
        display: "flex",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        background: "var(--surface-primary)",
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={activeTab === tab.id ? "gitboard-tab is-active" : "gitboard-tab"}
          onClick={() => onSelect(tab.id)}
          style={{
            padding: "8px 16px",
            background: "transparent",
            border: "none",
            borderBottom: activeTab === tab.id ? "2px solid var(--accent-blue)" : "2px solid transparent",
            color: activeTab === tab.id ? "var(--text-primary)" : "var(--text-muted)",
            fontSize: "var(--text-xs)",
            fontWeight: activeTab === tab.id ? 600 : 400,
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function GithubPanel({ onMount = useGithubActivity }: { onMount?: () => void } = {}) {
  onMount();

  const [socialOpen, setSocialOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("activity");
  const [dossierRepo, setDossierRepo] = useState<string | null>(null);

  const {
    events,
    selectedEvent,
    repos,
    repoStats,
    summary,
    filter,
    loading,
    error,
    unreadRepos,
    prs,
    issues,
    releases,
    selectEvent,
    setFilter,
    resetFilter,
    clearRepoUnread,
  } = useGithubStore();

  const ownEvents = events.filter((e) => !SOCIAL_TYPES.has(e.type));
  const socialEvents = events.filter((e) => SOCIAL_TYPES.has(e.type));

  // Derive owner username from events actor
  const ownerUsername = ownEvents[0]?.actor ?? null;

  // Build lastEventAt from repoStats — filter-independent, covers all repos in DB
  const lastEventAt: Record<string, string> = {};
  for (const [repo, stat] of Object.entries(repoStats)) {
    if (stat.last_event_at) lastEventAt[repo] = stat.last_event_at;
  }

  // Filter PRs and issues to owner's repos and respect the active repo selection.
  const selectedRepoSet = new Set(filter.repos ?? []);
  const repoMatchesFilter = (repo: string) => selectedRepoSet.size === 0 || selectedRepoSet.has(repo);
  const ownPrs = (ownerUsername ? prs.filter((pr) => pr.repo.startsWith(ownerUsername + "/")) : prs)
    .filter((pr) => repoMatchesFilter(pr.repo));
  const ownIssues = (ownerUsername ? issues.filter((issue) => issue.repo.startsWith(ownerUsername + "/")) : issues)
    .filter((issue) => repoMatchesFilter(issue.repo));
  const ownReleases = (ownerUsername ? releases.filter((release) => release.repo_full_name.startsWith(ownerUsername + "/")) : releases)
    .filter((release) => repoMatchesFilter(release.repo_full_name));

  function handleSelectEvent(evt: GithubEvent) {
    selectEvent(evt);
    clearRepoUnread(evt.repo);
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: "var(--text-base)" }}>
        Loading GitHub activity…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--accent-red)", fontSize: "var(--text-base)" }}>
        {error}
      </div>
    );
  }

  return (
    <div className="gitboard-shell" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left: Repo Sidebar */}
      <RepoSidebar
        repos={repos}
        stats={repoStats}
        selectedRepos={filter.repos ?? []}
        unreadRepos={unreadRepos}
        lastEventAt={lastEventAt}
        ownerUsername={ownerUsername}
        onSelect={(r) => setFilter({ repos: [r] })}
        onReset={resetFilter}
        onOpenDossier={(r) => setDossierRepo(r)}
      />

      {dossierRepo && <RepoDossier repo={dossierRepo} onClose={() => setDossierRepo(null)} />}

      {/* Center: Tabbed timeline */}
      <div className="gitboard-center" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <StatsHeader summary={summary} />

        <TabBar
          activeTab={activeTab}
          onSelect={setActiveTab}
          prCount={ownPrs.length}
          issueCount={ownIssues.length}
          releaseCount={ownReleases.length}
        />

        <div style={{ flex: 1, minHeight: 0 }}>
          {activeTab === "activity" && (
            <ActivityTimeline
              events={ownEvents}
              selectedId={selectedEvent?.id ?? null}
              onSelect={(evt) => void handleSelectEvent(evt)}
            />
          )}
          {activeTab === "prs" && <PrTimeline prs={ownPrs} />}
          {activeTab === "issues" && <IssueTimeline issues={ownIssues} />}
          {activeTab === "releases" && <ReleaseTimeline releases={ownReleases} />}
        </div>

        {/* Starred / Social strip — only shown on Activity tab */}
        {activeTab === "activity" && socialEvents.length > 0 && (
          <div style={{
            flexShrink: 0,
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--surface-secondary)",
          }}>
            <button
              onClick={() => setSocialOpen((o) => !o)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                padding: "6px 16px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-muted)",
                textAlign: "left",
              }}
            >
              <StarIcon size={12} />
              <span>{socialEvents.length} starred this week</span>
              <span style={{ marginLeft: "auto", fontSize: 10 }}>{socialOpen ? "▲" : "▼"}</span>
            </button>
            {socialOpen && (
              <div style={{ maxHeight: 160, overflowY: "auto", padding: "0 16px 8px" }}>
                {socialEvents.map((e) => (
                  <div key={e.id} style={{ fontSize: 11, color: "var(--text-secondary)", padding: "3px 0", display: "flex", gap: 6 }}>
                    <StarIcon size={11} />
                    <span style={{ color: "var(--text-muted)" }}>{e.actor}</span>
                    <span>starred</span>
                    <a href={`https://github.com/${e.repo}`} target="_blank" rel="noreferrer" style={{ color: "var(--text-primary)", textDecoration: "none" }}>{e.repo}</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
