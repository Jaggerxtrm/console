// BeadsRepoView (forge-5w9.7). Looks up a beads project by tail-of-repo-fullName,
// loads its open issues, then renders the ported KanbanBoard.

import { useEffect, useMemo, useState } from "react";
import { KanbanBoard } from "./KanbanBoard.tsx";
import { beadsApi } from "../../lib/beads-api.ts";
import type { BeadIssue, BeadsProject, Interaction } from "../../../types/beads.ts";
import type { RepoNode } from "../../../types/shell.ts";

interface State {
  loading: boolean;
  error: string | null;
  project: BeadsProject | null;
  issues: BeadIssue[];
  interactions: Interaction[];
}

function tailName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

export function BeadsRepoView({ repo }: { repo: RepoNode }) {
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    project: null,
    issues: [],
    interactions: [],
  });
  const [reloadKey, setReloadKey] = useState(0);

  const tail = useMemo(() => tailName(repo.fullName), [repo.fullName]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    async function load() {
      try {
        const projects = await beadsApi.listProjects();
        const project = projects.find((p) => p.name === tail);
        if (!project) {
          if (!cancelled) {
            setState({
              loading: false,
              error: `No beads project found matching "${tail}".`,
              project: null,
              issues: [],
              interactions: [],
            });
          }
          return;
        }
        const [openIssues, closedIssues, interactions] = await Promise.all([
          beadsApi.listIssues(project.id, { status: ["open", "in_progress", "blocked", "in_review"] }).catch(() => [] as BeadIssue[]),
          beadsApi.listClosedIssues(project.id, 20).catch(() => [] as BeadIssue[]),
          beadsApi.listInteractions(project.id).catch(() => [] as Interaction[]),
        ]);
        if (cancelled) return;
        setState({
          loading: false,
          error: null,
          project,
          issues: [...openIssues, ...closedIssues],
          interactions,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            project: null,
            issues: [],
            interactions: [],
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [tail, reloadKey]);

  if (state.loading) return <BeadsSkeleton />;
  if (state.error) {
    return (
      <div className="shell-error">
        <p className="shell-error-msg">{state.error}</p>
        <button type="button" className="shell-error-retry" onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </button>
      </div>
    );
  }
  if (!state.project) return null;

  return (
    <div className="shell-beads-view">
      <header className="shell-section-header">
        <span className="shell-section-title">Kanban — /{repo.displayName}</span>
        <span className="shell-section-meta">{state.issues.length} issues</span>
      </header>
      <KanbanBoard
        issues={state.issues}
        projectId={state.project.id}
        interactions={state.interactions}
      />
    </div>
  );
}

function BeadsSkeleton() {
  return (
    <div className="shell-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="shell-skeleton-col">
          <div className="shell-skeleton-col-head" />
          <div className="shell-skeleton-card" />
          <div className="shell-skeleton-card" />
          <div className="shell-skeleton-card" style={{ width: "60%" }} />
        </div>
      ))}
    </div>
  );
}
