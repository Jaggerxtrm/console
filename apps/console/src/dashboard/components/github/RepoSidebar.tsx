import { useState } from "react";
import { RepoIcon, LinkExternalIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon } from "@primer/octicons-react";
import type { GithubRepo, RepoStat } from "../../../../src/types/github.ts";
import { EventDetail } from "./EventDetail.tsx";
import type { GithubEvent, GithubCommit } from "../../../../src/types/github.ts";

interface Props {
  repos: GithubRepo[];
  stats: Record<string, RepoStat>;
  selectedRepos: string[];
  unreadRepos?: Set<string>;
  onSelect: (fullName: string) => void;
  onReset: () => void;
  lastEventAt?: Record<string, string>;
  ownerUsername?: string | null;
  selectedEvent?: GithubEvent | null;
  selectedEventCommits?: GithubCommit[];
}

export function filterOwnRepos(repos: GithubRepo[], lastEventAt: Record<string, string>): GithubRepo[] {
  if (Object.keys(lastEventAt).length === 0) return repos;
  return repos.filter((r) => r.full_name in lastEventAt);
}

export function sortByLastEvent(repos: GithubRepo[], lastEventAt: Record<string, string>): GithubRepo[] {
  return [...repos].sort((a, b) => {
    const ta = lastEventAt[a.full_name] ?? "";
    const tb = lastEventAt[b.full_name] ?? "";
    if (!ta && !tb) return a.full_name.localeCompare(b.full_name);
    if (!ta) return 1;
    if (!tb) return -1;
    return tb > ta ? 1 : tb < ta ? -1 : a.full_name.localeCompare(b.full_name);
  });
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function RepoSidebar({ repos, stats, selectedRepos, unreadRepos = new Set(), onSelect, onReset, lastEventAt = {}, ownerUsername = null, selectedEvent, selectedEventCommits }: Props) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [width, setWidth] = useState(() => {
    try {
      const saved = typeof window !== "undefined" ? window.localStorage?.getItem("sidebar-width") : null;
      return saved ? parseInt(saved, 10) : 240;
    } catch {
      return 240;
    }
  });

  function persistWidth(w: number) {
    setWidth(w);
    try { window.localStorage?.setItem("sidebar-width", String(w)); } catch { /* ignore */ }
  }

  function handleResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const onMove = (ev: MouseEvent) => {
      last = Math.max(160, Math.min(480, startW + ev.clientX - startX));
      setWidth(last);
    };
    const onUp = () => {
      persistWidth(last);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const ownRepos = ownerUsername ? repos.filter((r) => r.full_name.startsWith(ownerUsername + "/")) : repos;
  const sorted = sortByLastEvent(ownRepos, lastEventAt);

  const groups = new Map<string, GithubRepo[]>();
  for (const repo of sorted) {
    const key = repo.group_name ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(repo);
  }

  const allActive = selectedRepos.length === 0;

  return (
    <div className="console-repo-rail" style={{
      width: `clamp(160px, ${width}px, 480px)`,
      minWidth: 160,
      maxWidth: 480,
      background: "var(--surface-secondary)",
      borderRight: "1px solid var(--border-subtle)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
      flex: "0 1 auto",
    }}>
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: "col-resize",
          zIndex: 10,
        }}
      />
      {/* Scrollable repo list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "2px 0" }}>
        <button
          aria-pressed={allActive}
          className={allActive ? "repo-section-control is-active" : "repo-section-control"}
          title="Show all repos"
          onClick={onReset}
          style={{
            display: "flex",
            alignItems: "center",
            height: 28,
            padding: "0 12px",
            background: "var(--surface-secondary)",
            border: "none",
            borderBottom: "1px solid var(--border-subtle)",
            borderLeft: allActive ? "2px solid var(--event-push)" : "2px solid transparent",
            color: allActive ? "var(--text-primary)" : "var(--text-muted)",
            cursor: allActive ? "default" : "pointer",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "none",
            textAlign: "left",
            width: "100%",
            flexShrink: 0,
          }}
        >
          Repos
        </button>

        {Array.from(groups.entries()).map(([groupName, groupRepos]) => (
          <div key={groupName}>
            {groupName && (
              <div
                role="heading"
                className="repo-group-heading"
                style={{
                  padding: "8px 16px 4px",
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  textTransform: "none",
                }}
              >
                {groupName}
              </div>
            )}
            {groupRepos.map((repo) => {
              const stat = stats[repo.full_name];
              const isSelected = selectedRepos.includes(repo.full_name);
              const isUnread = unreadRepos.has(repo.full_name);
              const slug = repo.full_name.split("/")[1];
              const displayName = repo.display_name ?? slug;
              const lastAt = lastEventAt[repo.full_name];

              return (
                <button
                  key={repo.full_name}
                  aria-pressed={isSelected}
                  className={isSelected ? "repo-row is-active" : isUnread ? "repo-row has-unread" : "repo-row"}
                  onClick={() => onSelect(repo.full_name)}
                  onMouseEnter={() => setHoveredKey(repo.full_name)}
                  onMouseLeave={() => setHoveredKey(null)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    padding: "6px 12px",
                    background: isSelected ? "var(--surface-tertiary)" : hoveredKey === repo.full_name ? "rgba(255,255,255,0.04)" : "transparent",
                    border: "none",
                    borderLeft: isSelected ? "2px solid var(--event-push)" : "2px solid transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    fontSize: "var(--text-base)",
                    textAlign: "left",
                    width: "100%",
                    transition: "var(--transition-fast)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {isUnread && (
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: "var(--radius-pill)",
                        background: "var(--accent-blue)",
                        flexShrink: 0,
                      }} />
                    )}
                    <RepoIcon size={14} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {displayName}
                    </span>
                    {lastAt && (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", flexShrink: 0 }}>
                        {relativeTime(lastAt)}
                      </span>
                    )}
                    <a
                      href={`https://github.com/${repo.full_name}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: "var(--text-muted)", lineHeight: 1 }}
                    >
                      <LinkExternalIcon size={12} />
                    </a>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-secondary)", paddingLeft: 16 }}>
                    {stat ? (
                      <>
                        {stat.pushes > 0 && (
                          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <GitCommitIcon size={12} />
                            {stat.pushes}
                          </span>
                        )}
                        {stat.prs_closed > 0 && (
                          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <GitMergeIcon size={12} />
                            {stat.prs_closed}
                          </span>
                        )}
                        {stat.prs_open > 0 && (
                          <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--event-pr-open)" }}>
                            <GitPullRequestIcon size={12} />
                            {stat.prs_open}
                          </span>
                        )}
                        {stat.pushes === 0 && stat.prs_closed === 0 && stat.prs_open === 0 && (
                          <span style={{ color: "var(--text-muted)" }}>no activity today</span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>no activity today</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Inline event detail — shown when selectedEvent prop is provided */}
      {selectedEvent !== undefined && (
        <div style={{
          borderTop: "1px solid var(--border-subtle)",
          overflowY: "auto",
          maxHeight: "45%",
          flexShrink: 0,
          fontSize: "11px",
          lineHeight: 1.4,
        }}>
          <EventDetail event={selectedEvent ?? null} commits={selectedEventCommits ?? []} />
        </div>
      )}

    </div>
  );
}
