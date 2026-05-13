import { useEffect, useMemo, useState } from "react";
import { GitPullRequestIcon, IssueOpenedIcon, RepoIcon } from "@primer/octicons-react";

export interface ConsoleRepoRecord {
  id: string;
  name: string;
  path?: string;
  github?: {
    fullName: string;
    displayName: string;
    tracked: boolean;
    openPrs: number;
    closedPrs: number;
    openIssues: number;
    lastActivityAt: string | null;
  };
  beads?: {
    projectId: string;
    path: string;
    issueCount: number;
    open: number;
    inProgress: number;
    blocked: number;
    closed: number;
    epics: number;
    p0: number;
  };
  health: "active" | "idle" | "git-only" | "beads-only";
}

interface Props {
  selectedRepoId: string | null;
  onSelect: (repo: ConsoleRepoRecord | null) => void;
}

export function ConsoleRepoRail({ selectedRepoId, onSelect }: Props) {
  const [repos, setRepos] = useState<ConsoleRepoRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadRepos() {
      setLoading(true);
      try {
        const response = await fetch("/api/console/repos");
        const data = await response.json() as { repos: ConsoleRepoRecord[] };
        if (cancelled) return;
        setRepos(data.repos);
        if (!selectedRepoId && data.repos[0]) onSelect(data.repos[0]);
      } catch (error) {
        console.error(error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadRepos();
    return () => { cancelled = true; };
  }, []);

  const selectedRepo = useMemo(() => repos.find((repo) => repo.id === selectedRepoId) ?? null, [repos, selectedRepoId]);

  return (
    <aside className="xtrm-rail">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={selectedRepo ? "xtrm-rail-header" : "xtrm-rail-header is-active"}
      >
        <RepoIcon size={13} />
        Repos
        {loading && <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontWeight: 500 }}>scan</span>}
      </button>

      <div className="xtrm-rail-scroll">
        {repos.map((repo) => {
          const selected = repo.id === selectedRepoId;
          const activeBeads = (repo.beads?.open ?? 0) + (repo.beads?.inProgress ?? 0) + (repo.beads?.blocked ?? 0);
          const openPrs = repo.github?.openPrs ?? 0;
          const openIssues = repo.github?.openIssues ?? 0;
          return (
            <button
              key={repo.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(repo)}
              className={selected ? "xtrm-rail-row is-active" : "xtrm-rail-row"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: repo.health === "active" ? "rgba(142,210,220,0.85)" : "rgba(255,255,255,0.22)", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 650 }}>{repo.name}</span>
                {repo.beads && <span className="xtrm-tag beads">BD</span>}
                {repo.github && <span className="xtrm-tag git">GH</span>}
              </div>
              <div style={{ display: "flex", gap: 8, paddingLeft: 13, color: "var(--text-muted)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 3, color: openPrs > 0 ? "#8ed2dc" : "var(--text-muted)" }}><GitPullRequestIcon size={11} />{openPrs}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 3, color: openIssues > 0 ? "#d29922" : "var(--text-muted)" }}><IssueOpenedIcon size={11} />{openIssues}</span>
                <span style={{ color: activeBeads > 0 ? "#cdb8ff" : "var(--text-muted)" }}>bd {activeBeads}</span>
                {(repo.beads?.blocked ?? 0) > 0 && <span style={{ color: "#d1847f" }}>blk {repo.beads?.blocked}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
