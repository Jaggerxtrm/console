// BeadsRepoView (forge-7xu). Loads ALL data for the selected project once,
// then dispatches to one of the Beads tab views: feed, triage, memories.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IssueFeed } from "./IssueFeed.tsx";
import { IssueOverlay } from "./IssueOverlay.tsx";
import { substrateApi } from "../../lib/beads.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import { useWebSocket } from "../../hooks/useWebSocket.ts";
import { useInFlightJobs } from "../../hooks/useInFlightJobs.ts";
import type { SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";
import type { WsMessage } from "../../lib/ws.ts";
import type {
  BeadIssue,
  BeadIssueDetail,
  BeadsProject,
  Interaction,
  Memory,
} from "../../../types/beads.ts";
import type { RepoNode, BeadsTab } from "../../../types/shell.ts";

const REFETCH_COALESCE_MS = 1_500;
const LIVE_SPECIALIST_STATES = new Set(["starting", "running", "waiting", "error", "cancelled"]);

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

type BeadsMessageData = {
  projectId?: string;
  project_id?: string;
  issue?: BeadIssue;
  issueId?: string;
  id?: string;
  issues?: BeadIssue[];
  closes?: string[];
  deletes?: string[];
};

function getMessageData(msg: WsMessage): BeadsMessageData {
  return msg.data && typeof msg.data === "object" ? msg.data as BeadsMessageData : {};
}

function getMessageProjectId(data: BeadsMessageData): string | undefined {
  return data.projectId ?? data.project_id ?? data.issue?.project_id;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return [item, ...items.filter((current) => current.id !== item.id)];
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

function applyIssueUpsert(state: State, issue: BeadIssue): State {
  const open = removeById(state.issues, issue.id);
  const closed = removeById(state.closedIssues, issue.id);
  if (issue.status === "closed") return { ...state, issues: open, closedIssues: upsertById(closed, issue) };
  return { ...state, issues: upsertById(open, issue), closedIssues: closed };
}

function closeIssue(state: State, issueId: string): State {
  const issue = state.issues.find((item) => item.id === issueId) ?? state.closedIssues.find((item) => item.id === issueId);
  if (!issue) return state;
  const closed = { ...issue, status: "closed" as const, closed_at: issue.closed_at ?? issue.updated_at };
  return { ...state, issues: removeById(state.issues, issueId), closedIssues: upsertById(removeById(state.closedIssues, issueId), closed) };
}

function deleteIssue(state: State, issueId: string): State {
  return { ...state, issues: removeById(state.issues, issueId), closedIssues: removeById(state.closedIssues, issueId) };
}

function applyBeadsMessage(state: State, msg: WsMessage): State {
  const data = getMessageData(msg);
  switch (msg.event) {
    case "beads:issue.upsert":
    case "beads:issue.deferred":
    case "beads:issue.superseded":
    case "beads:issue.flagged":
    case "beads:issue.unflagged":
      return data.issue ? applyIssueUpsert(state, data.issue) : state;
    case "beads:issue.close":
      return closeIssue(state, data.issueId ?? data.id ?? "");
    case "beads:issue.delete":
      return deleteIssue(state, data.issueId ?? data.id ?? "");
    case "beads:batch": {
      let next = state;
      for (const issue of data.issues ?? []) next = applyIssueUpsert(next, issue);
      for (const issueId of data.closes ?? []) next = closeIssue(next, issueId);
      for (const issueId of data.deletes ?? []) next = deleteIssue(next, issueId);
      return next;
    }
    default:
      return state;
  }
}

function tailName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

function findProject(projects: BeadsProject[], candidates: string[]): BeadsProject | null {
  return projects.find((project) => candidates.includes(project.id) || candidates.includes(project.name)) ?? null;
}

function sameIssueSignature(left: BeadIssue, right: BeadIssue): boolean {
  return left.id === right.id
    && left.status === right.status
    && left.priority === right.priority
    && left.updated_at === right.updated_at
    && JSON.stringify(left.labels ?? []) === JSON.stringify(right.labels ?? []);
}

function sameIssues(next: BeadIssue[] | null, current: BeadIssue[]): boolean {
  return next !== null
    && next.length === current.length
    && next.every((issue, index) => sameIssueSignature(issue, current[index]));
}

function sameMemories(next: Memory[] | null, current: Memory[]): boolean {
  return next !== null
    && next.length === current.length
    && next.every((memory, index) => memory.id === current[index]?.id);
}

function sameInteractions(next: Interaction[] | null, current: Interaction[]): boolean {
  return next !== null
    && next.length === current.length
    && next.every((interaction, index) => interaction.id === current[index]?.id);
}

export function BeadsRepoView({ repo, tab }: { repo: RepoNode; tab: BeadsTab }) {
  const [state, setState] = useState<State>(INITIAL);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BeadIssueDetail | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const refetchTimer = useRef<number | null>(null);
  const loadedTailRef = useRef<string | null>(null);
  const visibleProjectRef = useRef<string | null>(null);
  const visibleIssueIdsRef = useRef<Set<string>>(new Set());
  const visibleChipKeysRef = useRef<Set<string>>(new Set());
  const visibleChipsInitializedRef = useRef(false);
  const renderSignatureRef = useRef<string>("");
  const inFlight = useInFlightJobs();

  const projectCandidates = useMemo(() => [repo.beadsProjectId, repo.beadsProjectName, tailName(repo.fullName), repo.displayName].filter((value): value is string => Boolean(value)), [repo.beadsProjectId, repo.beadsProjectName, repo.displayName, repo.fullName]);
  const projectKey = projectCandidates[0] ?? tailName(repo.fullName);

  useEffect(() => {
    let cancelled = false;
    const isProjectSwitch = loadedTailRef.current !== projectKey;
    loadedTailRef.current = projectKey;
    setState((s) => ({ ...s, loading: isProjectSwitch || !s.project, error: null }));
    if (isProjectSwitch) {
      visibleProjectRef.current = null;
      visibleIssueIdsRef.current = new Set();
      visibleChipKeysRef.current = new Set();
      visibleChipsInitializedRef.current = false;
      setSelectedId(null);
      setDetail(null);
    }

    async function load() {
      const startedAt = performance.now();
      logClientEvent("beads.feed.load_start", { projectKey, candidates: projectCandidates, isProjectSwitch });
      try {
        const projects = await substrateApi.listProjects();
        const project = findProject(projects, projectCandidates);
        if (!project) {
          if (!cancelled) {
            logClientEvent("beads.feed.project_missing", {
              projectKey,
              candidates: projectCandidates,
              availableProjects: projects.map((item) => ({ id: item.id, name: item.name })).slice(0, 100),
              ms: Math.round(performance.now() - startedAt),
            });
            setState((current) => current.project && !isProjectSwitch
              ? { ...current, loading: false, error: null }
              : { ...INITIAL, loading: false, error: `No beads project for "${projectKey}".` });
          }
          return;
        }
        const [issuesResult, memoriesResult, interactionsResult] = await Promise.all([
          substrateApi.listIssues(project.id, { status: ["open", "in_progress", "blocked", "in_review"], limit: 100 }).then((data) => data).catch(() => null as BeadIssue[] | null),
          substrateApi.listMemories(project.id).then((data) => data).catch(() => null as Memory[] | null),
          substrateApi.listInteractions(project.id).then((data) => data).catch(() => null as Interaction[] | null),
        ]);
        if (cancelled) return;
        logClientEvent("beads.feed.load_result", {
          projectId: project.id,
          projectName: project.name,
          projectKey,
          ms: Math.round(performance.now() - startedAt),
          issues: (issuesResult ?? []).length,
          memories: (memoriesResult ?? []).length,
          interactions: (interactionsResult ?? []).length,
          newestIssue: newestIssueSummary(issuesResult ?? []),
          issueIds: (issuesResult ?? []).slice(0, 50).map((issue) => issue.id),
        });
        setState((current) => ({
          loading: false,
          error: null,
          project,
          issues: issuesResult === null
            ? (current.project?.id === project.id ? current.issues : [])
            : sameIssues(issuesResult, current.issues)
              ? current.issues
              : issuesResult,
          closedIssues: current.project?.id === project.id ? current.closedIssues : [],
          memories: memoriesResult === null
            ? (current.project?.id === project.id ? current.memories : [])
            : sameMemories(memoriesResult, current.memories)
              ? current.memories
              : memoriesResult,
          interactions: interactionsResult === null
            ? (current.project?.id === project.id ? current.interactions : [])
            : sameInteractions(interactionsResult, current.interactions)
              ? current.interactions
              : interactionsResult,
        }));

        void substrateApi.listClosedIssues(project.id, 50)
          .then((closedIssues) => {
            if (!cancelled) setState((current) => current.project?.id === project.id ? { ...current, closedIssues } : current);
          })
          .catch(() => undefined);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          logClientEvent("beads.feed.load_error", {
            projectKey,
            candidates: projectCandidates,
            ms: Math.round(performance.now() - startedAt),
            message,
          });
          setState((current) => current.project && !isProjectSwitch
            ? { ...current, loading: false, error: null }
            : { ...INITIAL, loading: false, error: message });
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectCandidates, projectKey, reloadKey]);

  const scheduleCoalescedRefetch = useCallback(() => {
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      setReloadKey((k) => k + 1);
    }, REFETCH_COALESCE_MS);
  }, []);

  useEffect(() => () => {
    if (refetchTimer.current !== null) {
      window.clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
    }
  }, []);

  const handleBeadsMessage = useCallback((msg: WsMessage) => {
    if (!state.project) return;
    const data = getMessageData(msg);
    const projectId = getMessageProjectId(data);
    if (projectId && projectId !== state.project.id) return;

    logClientEvent("beads.feed.ws_message", {
      event: msg.event,
      projectId: projectId ?? state.project.id,
      issueId: data.issue?.id ?? data.issueId ?? data.id ?? null,
      batchIssues: data.issues?.length ?? 0,
      currentIssues: state.issues.length,
    });

    if (msg.event === "substrate:sync_hint") {
      scheduleCoalescedRefetch();
      return;
    }
    if (!projectId) return;

    setState((current) => applyBeadsMessage(current, msg));

    const changedIssueId = data.issue?.id ?? data.issueId ?? data.id;
    if (selectedId && changedIssueId === selectedId) {
      void substrateApi.getIssue(state.project.id, selectedId).then(setDetail);
    }
  }, [scheduleCoalescedRefetch, selectedId, state.issues.length, state.project]);

  useWebSocket("substrate:changes", handleBeadsMessage);

  const specialistByIssueId = useMemo(() => buildSpecialistByIssueId(inFlight.jobs, state.project), [inFlight.jobs, state.project]);

  useEffect(() => {
    if (!state.project || state.loading) return;

    if (visibleProjectRef.current !== state.project.id) {
      visibleProjectRef.current = state.project.id;
      visibleIssueIdsRef.current = new Set(state.issues.map((issue) => issue.id));
      logClientEvent("beads.feed.visible_snapshot", {
        projectId: state.project.id,
        projectName: state.project.name,
        issues: state.issues.length,
        newestIssue: newestIssueSummary(state.issues),
        issueIds: state.issues.slice(0, 50).map((issue) => issue.id),
      });
      return;
    }

    for (const issue of state.issues) {
      if (visibleIssueIdsRef.current.has(issue.id)) continue;
      visibleIssueIdsRef.current.add(issue.id);
      logClientEvent("beads.feed.issue_visible", {
        projectId: state.project.id,
        projectName: state.project.name,
        issue: summarizeIssueForLog(issue),
      });
    }
  }, [state.issues, state.loading, state.project]);

  useEffect(() => {
    if (!state.project || state.loading) return;

    const entries = [...specialistByIssueId.entries()];
    if (!visibleChipsInitializedRef.current) {
      visibleChipsInitializedRef.current = true;
      visibleChipKeysRef.current = new Set(entries.map(([issueId, job]) => chipKey(issueId, job)));
      logClientEvent("beads.feed.specialist_chips_snapshot", {
        projectId: state.project.id,
        projectName: state.project.name,
        chips: entries.length,
        chipsSummary: entries.slice(0, 50).map(([issueId, job]) => summarizeChipForLog(issueId, job)),
      });
      return;
    }

    for (const [issueId, job] of entries) {
      const key = chipKey(issueId, job);
      if (visibleChipKeysRef.current.has(key)) continue;
      visibleChipKeysRef.current.add(key);
      logClientEvent("beads.feed.specialist_chip_visible", {
        projectId: state.project.id,
        projectName: state.project.name,
        chip: summarizeChipForLog(issueId, job),
      });
    }
  }, [specialistByIssueId, state.loading, state.project]);

  useEffect(() => {
    const signature = JSON.stringify({
      loading: state.loading,
      error: Boolean(state.error),
      projectId: state.project?.id ?? null,
      issues: state.issues.length,
      closedIssues: state.closedIssues.length,
      tab,
    });
    if (renderSignatureRef.current === signature) return;
    renderSignatureRef.current = signature;
    logClientEvent("beads.feed.render_state", {
      loading: state.loading,
      error: state.error,
      projectId: state.project?.id ?? null,
      projectName: state.project?.name ?? null,
      issues: state.issues.length,
      closedIssues: state.closedIssues.length,
      tab,
      wouldShowSkeleton: state.loading && !state.project,
      wouldShowEmpty: !state.loading && !state.error && Boolean(state.project) && state.issues.length === 0,
    });
  }, [state.closedIssues.length, state.error, state.issues.length, state.loading, state.project, tab]);

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
      const d = await substrateApi.getIssue(state.project.id, issue.id);
      setDetail(d);
    } finally {
      setLoadingDetailId(null);
    }
  }, [selectedId, state.project]);

  if (state.loading && !state.project) return <BeadsSkeleton />;
  if (state.error && !state.project) {
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
          specialistByIssueId={specialistByIssueId}
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

function summarizeIssueForLog(issue: BeadIssue): Record<string, unknown> {
  const maybeAssignee = "assignee" in issue ? issue.assignee : null;
  return {
    id: issue.id,
    title: truncateForLog(issue.title, 120),
    status: issue.status,
    priority: issue.priority,
    issue_type: issue.issue_type,
    owner: issue.owner ?? null,
    assignee: maybeAssignee,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function newestIssueSummary(issues: BeadIssue[]): Record<string, unknown> | null {
  const newest = [...issues].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  return newest ? summarizeIssueForLog(newest) : null;
}

function summarizeChipForLog(issueId: string, job: SpecialistOwnershipJob): Record<string, unknown> {
  return {
    issueId,
    role: job.role,
    state: job.state,
    repoSlug: job.repoSlug,
    jobId: job.jobId,
  };
}

function chipKey(issueId: string, job: SpecialistOwnershipJob): string {
  return `${issueId}:${job.jobId ?? "no-job"}:${job.state}:${job.role}`;
}

function truncateForLog(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildSpecialistByIssueId(jobs: Array<{ beadId: string; status: string; specialist?: string | null; chainKind?: string | null; repoSlug: string; jobId?: string | null }>, project: BeadsProject | null): Map<string, SpecialistOwnershipJob> {
  const byIssue = new Map<string, SpecialistOwnershipJob>();
  if (!project) return byIssue;

  for (const job of jobs) {
    if (job.repoSlug !== project.id && job.repoSlug !== project.name) continue;
    if (!LIVE_SPECIALIST_STATES.has(job.status)) continue;

    const current = byIssue.get(job.beadId);
    if (current && current.state === "running") continue;

    byIssue.set(job.beadId, {
      role: job.specialist || job.chainKind || "executor",
      state: job.status,
      repoSlug: job.repoSlug,
      jobId: job.jobId ?? null,
    });
  }

  return byIssue;
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
