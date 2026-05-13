import { CalendarIcon, UploadIcon, GitPullRequestIcon, GitCommitIcon, RepoIcon } from "@primer/octicons-react";
import type { Summary } from "../../../types/github.ts";

interface Props {
  summary: Summary | null;
}

const STATS: Array<{ key: keyof Summary; label: string; Icon: React.ComponentType<{ size?: number }> }> = [
  { key: "events",  label: "Events",  Icon: CalendarIcon },
  { key: "pushes",  label: "Pushes",  Icon: UploadIcon },
  { key: "prs",     label: "PRs",     Icon: GitPullRequestIcon },
  { key: "commits", label: "Commits", Icon: GitCommitIcon },
  { key: "repos",   label: "Repos",   Icon: RepoIcon },
];

export function StatsHeader({ summary }: Props) {
  return (
    <div className="gitboard-statsbar" style={{
      display: "flex",
      alignItems: "center",
      height: 32,
      padding: "0 16px",
      gap: 0,
      background: "var(--surface-secondary)",
      borderBottom: "1px solid var(--border-subtle)",
      flexShrink: 0,
    }}>
      {STATS.map(({ key, label, Icon }, i) => (
        <div key={key} className="gitboard-stat" style={{ display: "flex", alignItems: "center" }}>
          {i > 0 && (
            <span style={{ margin: "0 10px", color: "var(--text-muted)", fontSize: 11 }}>·</span>
          )}
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            <Icon size={12} />
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
              {summary ? String(summary[key]) : "—"}
            </span>
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
