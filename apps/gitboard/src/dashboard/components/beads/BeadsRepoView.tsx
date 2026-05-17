// BeadsRepoView (forge-7xu). Loads ALL data for the selected project once,
// then dispatches to one of the Beads tab views: feed, triage, memories.

import { useCallback, useEffect, useMemo, useState } from "react";
import { IssueFeed } from "./IssueFeed.tsx";
import { IssueOverlay } from "./IssueOverlay.tsx";
import { beadsApi } from "../../lib/beads-api.ts";
import type {
  BeadIssue,
  BeadIssueDetail,
  BeadsProject,
  Interaction,
  Memory,
} from "../../../types/beads.ts";
import type { RepoNode, BeadsTab } from "../../../types/shell.ts";

interface State {
  loading: boolean;
  error: string | null;
  project: BeadsProject | null;
  issues: BeadIssue[];
  closedIssues: BeadIssue[];
  memories: Memory[];
  interactions: Interaction[];
}

const INITIAL: State = {
  loading: true, error: null, project: null,
  issues: [], closedIssues: [], memories: [], interactions: [],
};

function tailName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

export function BeadsRepoView({ repo, tab }: { repo: RepoNode; tab: BeadsTab }) {
  const [state, setState] = useState<State>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const tail = useMemo(() => tailName(repo.fullName), [repo.fullName]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    setSelectedId(null);
    setDetail(null);

    async function load() {
      try {
        const projects = await beadsApi.listProjects();
        const project = projects.find((p) => p.name === tail);
        if (!project) {
          if (!cancelled) {
            setState({ ...INITIAL, loading: false, error: `No beads project for "${tail}".` });
          }
          return;
        }
        // Single fetch — backend /issues/closed returns 404 on Dolt-backed projects.
        // The unfiltered /issues endpoint returns everything (open + closed) from Dolt.
        const [allIssues, memories, interactions] = await Promise.all([
          beadsApi.listIssues(project.id, { limit: 1000 }).catch(() => [] as BeadIssue[]),
          beadsApi.listMemories(project.id).catch(() => [] as Memory[]),
          beadsApi.listInteractions(project.id).catch(() => [] as Interaction[]),
        ]);
        if (cancelled) return;
        const issues = allIssues.filter((i) => i.status !== "closed");
        const closedIssues = allIssues.filter((i) => i.status === "closed");
        setState({ loading: false, error: null, project, issues, closedIssues, memories, interactions });
      } catch (err) {
        if (!cancelled) {
          setState({ ...INITIAL, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [tail, reloadKey]);

  const onIssueSelect = useCallback(async (issue: BeadIssue) => {
    if (!state.project) return;
    if (selectedId === issue.id) {
      setSelectedId(null);
      setDetail(null);
      setLoadingDetailId(null);
      return;
    }
    setSelectedId(issue.id);
    setDetail(null);
    setLoadingDetailId(issue.id);
    try {
      const d = await beadsApi.getIssue(state.project.id, issue.id);
      setDetail(d);
    } finally {
      setLoadingDetailId(null);
    }
  }, [selectedId, state.project]);

  if (state.loading) return <BeadsSkeleton />;
  if (state.error) {
    return (
      <div className="ide-error">
        <p className="ide-error-msg">{state.error}</p>
        <button type="button" className="ide-btn" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
      </div>
    );
  }
  if (!state.project) return null;

  const issueById = new Map([...state.issues, ...state.closedIssues].map((i) => [i.id, i]));
  const selectedIssue = selectedId ? issueById.get(selectedId) : null;

  return (
    <div className="ide-beads-pane">
      {tab === "feed" && (
        <IssueFeed
          issues={state.issues}
          closedIssues={state.closedIssues}
          selectedIssueId={selectedId}
          selectedIssueDetail={detail}
          loadingDetailId={loadingDetailId}
          onIssueSelect={onIssueSelect}
          getAgent={() => null}
          projectId={state.project.id}
        />
      )}
      {tab === "triage" && (
        <TriagePanel issues={state.issues} closedIssues={state.closedIssues} onIssueSelect={onIssueSelect} />
      )}
      {tab === "memories" && (
        <MemoriesPanel memories={state.memories} />
      )}

      {tab !== "feed" && selectedIssue && (
        <IssueOverlay
          issue={selectedIssue}
          detail={detail}
          loading={loadingDetailId === selectedIssue.id}
          projectId={state.project.id}
          issueById={issueById}
          onClose={() => { setSelectedId(null); setDetail(null); }}
        />
      )}
    </div>
  );
}

// ── Closed ────────────────────────────────────────────────────────────────────

// ── Memories ──────────────────────────────────────────────────────────────────

function MemoriesPanel({ memories }: { memories: Memory[] }) {
  if (memories.length === 0) {
    return (
      <div className="ide-empty">
        <p>No memories stored. Use <code>bd remember "insight"</code> to add one.</p>
      </div>
    );
  }
  return (
    <div className="ide-list">
      {memories.map((m) => (
        <article key={m.id} className="ide-list-card">
          <header className="ide-list-card-head">
            <span className="ide-list-card-tag">{m.type}</span>
            {m.tags.map((t) => <span key={t} className="ide-list-card-chip">#{t}</span>)}
          </header>
          <p className="ide-list-card-body">{m.content}</p>
          {m.issue_id && <p className="ide-list-card-meta">Issue: {m.issue_id}</p>}
        </article>
      ))}
    </div>
  );
}

// ── Triage ────────────────────────────────────────────────────────────────────

const STALE_DAYS = 7;
const PRIORITY_WEIGHT: Record<number, number> = { 0: 1, 1: 0.75, 2: 0.5, 3: 0.25, 4: 0 };

type TriageIssue = BeadIssue & { score: number; daysIdle: number; blockerCount: number };

function getDaysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function buildTriage(issues: BeadIssue[], closed: BeadIssue[]) {
  const open = issues.filter((i) => i.status !== "closed");
  const scored: TriageIssue[] = open.map((issue) => {
    const daysIdle = getDaysSince(issue.updated_at ?? issue.created_at);
    const blockerCount = issue.dependencies.filter((d) =>
      d.dependency_type === "blocks" || d.dependency_type === "blocked_by",
    ).length;
    const pri = PRIORITY_WEIGHT[issue.priority as number] ?? 0;
    const stale = Math.min(daysIdle / 30, 1);
    const load = Math.min(open.length / 100, 1);
    return { ...issue, daysIdle, blockerCount, score: pri + stale + load };
  });
  const now = Date.now();
  const closedAt = (i: BeadIssue) => new Date(i.closed_at ?? i.updated_at).getTime();
  return {
    topPicks: [...scored].sort((a, b) => b.score - a.score).slice(0, 5),
    quickWins: scored.filter((i) => i.priority >= 2 && i.blockerCount === 0)
      .sort((a, b) => a.priority - b.priority || b.score - a.score).slice(0, 5),
    stale: scored.filter((i) => i.daysIdle >= STALE_DAYS)
      .sort((a, b) => b.daysIdle - a.daysIdle).slice(0, 5),
    velocity: {
      last7: closed.filter((i) => now - closedAt(i) <= 7 * 86_400_000).length,
      last30: closed.filter((i) => now - closedAt(i) <= 30 * 86_400_000).length,
    },
    countsByStatus: tally(issues, "status"),
    countsByType: tally(issues, "issue_type"),
    countsByPriority: tally(issues, "priority", (v) => `P${v}`),
  };
}

function tally<K extends keyof BeadIssue>(
  arr: BeadIssue[],
  key: K,
  fmt: (v: BeadIssue[K]) => string = String,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of arr) {
    const k = fmt(i[key]);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function TriagePanel({
  issues, closedIssues, onIssueSelect,
}: {
  issues: BeadIssue[];
  closedIssues: BeadIssue[];
  onIssueSelect: (i: BeadIssue) => void;
}) {
  const t = useMemo(() => buildTriage(issues, closedIssues), [issues, closedIssues]);
  return (
    <div className="ide-triage">
      <Section title="Top picks">
        {t.topPicks.length === 0 ? <Empty>No open issues</Empty> : (
          <ul className="ide-triage-list">
            {t.topPicks.map((i) => (
              <TriageRow key={i.id} issue={i} onClick={() => onIssueSelect(i)} score={i.score} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Quick wins">
        {t.quickWins.length === 0 ? <Empty>No quick wins</Empty> : (
          <ul className="ide-triage-list">
            {t.quickWins.map((i) => (
              <TriageRow key={i.id} issue={i} onClick={() => onIssueSelect(i)} score={i.score} />
            ))}
          </ul>
        )}
      </Section>
      <Section title={`Stale (${STALE_DAYS}d+)`}>
        {t.stale.length === 0 ? <Empty>No stale issues</Empty> : (
          <ul className="ide-triage-list">
            {t.stale.map((i) => (
              <TriageRow key={i.id} issue={i} onClick={() => onIssueSelect(i)} score={i.daysIdle} suffix="d" />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Velocity">
        <div className="ide-triage-stats">
          <Stat label="Closed (7d)" value={String(t.velocity.last7)} />
          <Stat label="Closed (30d)" value={String(t.velocity.last30)} />
        </div>
      </Section>
      <Section title="Project health">
        <StatGroup label="By status" items={t.countsByStatus} />
        <StatGroup label="By type" items={t.countsByType} />
        <StatGroup label="By priority" items={t.countsByPriority} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ide-triage-section">
      <h3 className="ide-triage-title">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="ide-empty-msg">{children}</p>;
}

function TriageRow({
  issue, onClick, score, suffix = "",
}: { issue: BeadIssue; onClick: () => void; score: number; suffix?: string }) {
  return (
    <li>
      <button type="button" className="ide-triage-row" onClick={onClick}>
        <span className="ide-triage-id">{issue.id}</span>
        <span className="ide-triage-pri">P{issue.priority}</span>
        <span className="ide-triage-row-title">{issue.title}</span>
        <span className="ide-triage-score">{Math.round(score * 100) / 100}{suffix}</span>
      </button>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ide-stat">
      <div className="ide-stat-label">{label}</div>
      <div className="ide-stat-value">{value}</div>
    </div>
  );
}

function StatGroup({ label, items }: { label: string; items: Record<string, number> }) {
  return (
    <div className="ide-stat-group">
      <div className="ide-stat-group-label">{label}</div>
      <div className="ide-triage-stats">
        {Object.entries(items).map(([k, v]) => <Stat key={k} label={k} value={String(v)} />)}
      </div>
    </div>
  );
}

function BeadsSkeleton() {
  return (
    <div className="ide-skeleton">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="ide-skeleton-col">
          <div className="ide-skeleton-head" />
          <div className="ide-skeleton-card" />
          <div className="ide-skeleton-card" />
        </div>
      ))}
    </div>
  );
}
