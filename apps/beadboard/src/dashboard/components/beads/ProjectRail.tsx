import { useMemo, useState } from "react";
import { AlertIcon, CheckCircleIcon, CircleSlashIcon, DatabaseIcon, RepoIcon, SyncIcon } from "@primer/octicons-react";
import type { BeadsProject, ProjectSourceHealth, ProjectSourceKind } from "../../../types/beads.ts";

export interface ProjectRailStats {
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  closed: number;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
}

interface ProjectRailProps {
  projects: BeadsProject[];
  selectedProjectId: string | null;
  statsByProject: Record<string, ProjectRailStats | undefined>;
  loadingStats?: boolean;
  onSelectProject: (projectId: string) => void;
}

const SOURCE_LABELS: Record<ProjectSourceKind, string> = {
  dolt: "Dolt",
  sqlite: "SQLite",
  jsonl: "JSONL",
  unknown: "No source",
};

export function ProjectRail({ projects, selectedProjectId, statsByProject, loadingStats = false, onSelectProject }: ProjectRailProps) {
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aStats = statsByProject[a.id];
      const bStats = statsByProject[b.id];
      const aActive = (aStats?.in_progress ?? 0) + (aStats?.blocked ?? 0) + (aStats?.open ?? a.issueCount ?? 0);
      const bActive = (bStats?.in_progress ?? 0) + (bStats?.blocked ?? 0) + (bStats?.open ?? b.issueCount ?? 0);
      if (aActive !== bActive) return bActive - aActive;
      return a.name.localeCompare(b.name);
    });
  }, [projects, statsByProject]);

  return (
    <aside style={{ width: "var(--sidebar-width)", minWidth: "var(--sidebar-width)", borderRight: "1px solid var(--border-subtle)", background: "var(--surface-secondary)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 32, padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-secondary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: "var(--text-xs)", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          <RepoIcon size={13} />
          Projects
        </div>
        {loadingStats && <span style={{ color: "var(--text-muted)", lineHeight: 0 }}><SyncIcon size={12} /></span>}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "4px 0" }}>
        {sortedProjects.length === 0 ? (
          <div style={{ padding: 16, color: "var(--text-muted)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
            No Beads projects found. Run <code style={{ background: "var(--surface-tertiary)", padding: "2px 5px", borderRadius: 4 }}>bd init</code> in a repo to make it visible.
          </div>
        ) : sortedProjects.map((project) => {
          const isSelected = project.id === selectedProjectId;
          const stats = statsByProject[project.id];
          const health = summarizeSource(project);
          const sourceLabel = SOURCE_LABELS[project.source ?? "unknown"] ?? project.source ?? "No source";
          const activeCount = (stats?.open ?? project.issueCount ?? 0) + (stats?.in_progress ?? 0) + (stats?.blocked ?? 0);
          const epicCount = Number(stats?.by_type?.epic ?? 0);
          const priorityZero = Number(stats?.by_priority?.["0"] ?? 0);

          return (
            <button
              key={project.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectProject(project.id)}
              onMouseEnter={() => setHoveredProjectId(project.id)}
              onMouseLeave={() => setHoveredProjectId(null)}
              style={{
                width: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 5,
                padding: "8px 16px",
                border: "none",
                borderTop: "1px solid transparent",
                borderBottom: "1px solid var(--border-subtle)",
                borderLeft: isSelected ? "2px solid var(--accent-blue)" : "2px solid transparent",
                background: isSelected ? "var(--surface-tertiary)" : hoveredProjectId === project.id ? "var(--surface-hover)" : "transparent",
                color: "var(--text-primary)",
                cursor: isSelected ? "default" : "pointer",
                textAlign: "left",
                transition: "background 120ms ease, border-color 120ms ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <SourceIcon health={health.state} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{project.name}</div>
                  <div style={{ marginTop: 1, fontSize: "10px", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{compactPath(project.path)}</div>
                </div>
                <span style={{ fontSize: "var(--text-xs)", color: activeCount > 0 ? "var(--text-primary)" : "var(--text-muted)", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 0, padding: "2px 7px" }}>{activeCount}</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4 }}>
                <CountPill label="Open" value={stats?.open ?? project.issueCount ?? 0} tone="var(--status-open)" />
                <CountPill label="Run" value={stats?.in_progress ?? 0} tone="var(--accent-blue)" />
                <CountPill label="Blk" value={stats?.blocked ?? 0} tone="var(--status-blocked)" />
                <CountPill label="Epic" value={epicCount} tone="var(--accent-purple)" />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", fontSize: "var(--text-xs)", minWidth: 0 }}>
                <DatabaseIcon size={12} />
                <span style={{ color: health.color, fontWeight: 600 }}>{sourceLabel}</span>
                <span>·</span>
                <span>{health.label}</span>
                {priorityZero > 0 && <span style={{ marginLeft: "auto", color: "var(--accent-orange)", fontWeight: 700 }}>P0 {priorityZero}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function CountPill({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 3, minWidth: 0, padding: "2px 4px", borderRadius: 0, background: "#1d1d1d", border: "1px solid var(--border-subtle)", fontSize: 9, color: "var(--text-muted)" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ color: value > 0 ? tone : "var(--text-disabled)", fontWeight: 750 }}>{value}</span>
    </span>
  );
}

function SourceIcon({ health }: { health: ProjectSourceHealth["state"] }) {
  if (health === "available") return <span style={{ color: "var(--accent-green)", flexShrink: 0, lineHeight: 0 }}><CheckCircleIcon size={14} /></span>;
  if (health === "unhealthy") return <span style={{ color: "var(--status-blocked)", flexShrink: 0, lineHeight: 0 }}><AlertIcon size={14} /></span>;
  return <span style={{ color: "var(--text-disabled)", flexShrink: 0, lineHeight: 0 }}><CircleSlashIcon size={14} /></span>;
}

function summarizeSource(project: BeadsProject): { state: ProjectSourceHealth["state"]; label: string; color: string } {
  const health = project.sourceHealth?.find((entry) => entry.kind === project.source) ?? project.sourceHealth?.find((entry) => entry.state === "available") ?? project.sourceHealth?.[0];
  if (!health) return { state: "missing", label: "not indexed", color: "var(--text-disabled)" };
  if (health.state === "available") return { state: health.state, label: health.detail ?? "available", color: "var(--accent-green)" };
  if (health.state === "unhealthy") return { state: health.state, label: health.detail ?? "unhealthy", color: "var(--status-blocked)" };
  return { state: health.state, label: health.detail ?? "missing", color: "var(--text-disabled)" };
}

function compactPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/");
}
