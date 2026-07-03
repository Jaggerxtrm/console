import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, DotFillIcon, PlayIcon, XCircleIcon } from "@primer/octicons-react";
import { ResultMarkdown } from "../../../lib/markdown.tsx";
import { substrateApi } from "../../../lib/substrate-api.ts";
import type { ChainJob, ChainSummary } from "../../../hooks/useChains.ts";
import { useChainDetail } from "../../../hooks/useChainDetail.ts";
import type { BeadIssueDetail } from "../../../../types/beads.ts";
import { beadSideDrawer } from "../../../hooks/useBeadSideDrawer.ts";
import type { ChainIssueContext } from "./chainIssueContext.ts";
import { RELATIONSHIP_LABEL } from "./chainIssueContext.ts";
import { IssueContextChip } from "./IssueContextChip.tsx";

const STATUS_ICON = {
  starting: ClockIcon,
  running: PlayIcon,
  waiting: ClockIcon,
  done: CheckIcon,
  error: AlertIcon,
  failed: AlertIcon,
  cancelled: XCircleIcon,
} as const;

type StatusKey = keyof typeof STATUS_ICON;
type ResultPayload = { text: string; content_type?: string };
type FeedEvidenceRef = { kind?: string; id?: string; evidence_id?: string; sha?: string; number?: number };
type FeedEventPayload = {
  schema_version?: string | number;
  event_family?: string;
  event_name?: string;
  resource?: { participant_kind?: string; participant_role?: string };
  correlation?: { job_id?: string };
  body?: { evidence_refs?: FeedEvidenceRef[] };
  redaction?: { status?: string };
  trace?: { trace_id?: string; span_id?: string; parent_span_id?: string };
  links?: unknown[];
};

function isFeedEventPayload(value: unknown): value is FeedEventPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const resource = candidate.resource;
  const correlation = candidate.correlation;
  const body = candidate.body;
  const redaction = candidate.redaction;
  const trace = candidate.trace;
  const links = candidate.links;
  return (
    (candidate.schema_version === undefined || typeof candidate.schema_version === "string" || typeof candidate.schema_version === "number")
    && (candidate.event_family === undefined || typeof candidate.event_family === "string")
    && (candidate.event_name === undefined || typeof candidate.event_name === "string")
    && (resource === undefined || (typeof resource === "object" && resource !== null && ((resource as Record<string, unknown>).participant_kind === undefined || typeof (resource as Record<string, unknown>).participant_kind === "string") && ((resource as Record<string, unknown>).participant_role === undefined || typeof (resource as Record<string, unknown>).participant_role === "string")))
    && (correlation === undefined || (typeof correlation === "object" && correlation !== null && ((correlation as Record<string, unknown>).job_id === undefined || typeof (correlation as Record<string, unknown>).job_id === "string")))
    && (body === undefined || (typeof body === "object" && body !== null))
    && (redaction === undefined || (typeof redaction === "object" && redaction !== null && ((redaction as Record<string, unknown>).status === undefined || typeof (redaction as Record<string, unknown>).status === "string")))
    && (trace === undefined || (typeof trace === "object" && trace !== null))
    && (links === undefined || Array.isArray(links))
  );
}

// Borderless status palette — coloured chip + faint matching background fill,
// so the role/jobId tag reads at a glance like the Feed status marks.
const STATUS_COLOR: Record<string, { fg: string; bg: string }> = {
  starting:  { fg: "var(--graph-state-wip)",      bg: "rgba(212, 161, 89, 0.10)" },
  running:   { fg: "var(--graph-state-wip)",      bg: "rgba(212, 161, 89, 0.10)" },
  waiting:   { fg: "var(--graph-state-wip)",      bg: "rgba(212, 161, 89, 0.10)" },
  done:      { fg: "var(--graph-state-closed)",   bg: "rgba(72, 159, 110, 0.10)" },
  error:     { fg: "var(--graph-priority-0)",     bg: "rgba(217, 95, 81, 0.10)" },
  failed:    { fg: "var(--graph-priority-0)",     bg: "rgba(217, 95, 81, 0.10)" },
  cancelled: { fg: "var(--text-muted)",            bg: "rgba(255, 255, 255, 0.04)" },
};

export function ChainDetailPane({ chain, issueContext, graphLoading = false, projectId }: { chain: ChainSummary | null; issueContext?: ChainIssueContext; graphLoading?: boolean; projectId?: string | null }) {
  const hasPersistedChainId = chain?.jobs.some((job) => job.chainId === chain.chainId) ?? false;
  const { jobs, loading, error } = useChainDetail(hasPersistedChainId ? chain?.chainId ?? null : null);
  const contractProjectId = projectId ?? chain?.jobs[0]?.repoSlug ?? null;
  const contract = useBeadContract(contractProjectId, chain?.rootBeadId ?? null);

  if (!chain) {
    return <EmptyState />;
  }

  const detailJobs = jobs.length > 0 ? jobs : chain.jobs;
  const roles = chain.roles.map((role) => role.role).join(", ") || "unknown";
  const chainKinds = [...new Set(detailJobs.map((job) => job.chainKind).filter(Boolean))].join(", ") || "unknown";
  const lastUsefulOutput = excerpt(detailJobs.findLast((job) => job.lastOutput?.trim())?.lastOutput ?? chain.lastMessage);

  return (
    <section className="console-specialists-detail">
      <div className="console-specialists-detail-header">
        <span className="console-specialists-detail-id">{chain.rootBeadId}</span>
        <span className="console-specialists-card-sep">/</span>
        <span className="console-specialists-detail-title">{chain.title}</span>
        <button type="button" className="console-specialists-open-bead" onClick={() => openBead(chain.rootBeadId, contract.issue)}>Open bead inspector</button>
      </div>
      <div className="console-specialists-detail-summary">
        <div className="console-specialists-detail-summary-row">
          <span><b>Root bead</b>{chain.rootBeadId}</span>
          <span><b>Status</b>{chain.status}</span>
          <span><b>Jobs</b>{detailJobs.length}</span>
          <span><b>Updated</b>{formatElapsed(chain.lastUpdatedAt)}</span>
        </div>
        <div className="console-specialists-detail-summary-row">
          <span><b>Roles</b>{roles}</span>
          <span><b>Kind</b>{chainKinds}</span>
        </div>
        {lastUsefulOutput ? (
          <div className="console-specialists-detail-summary-row console-specialists-detail-output-row">
            <span><b>Latest output</b>{lastUsefulOutput}</span>
          </div>
        ) : null}
        <div className="console-specialists-detail-actions">
          <button type="button" className="ide-btn" onClick={() => openBead(chain.rootBeadId, contract.issue)}>Open bead inspector</button>
        </div>
      </div>
      <BeadContractPanel issue={contract.issue} loading={contract.loading} error={contract.error} fallbackId={chain.rootBeadId} />
      <IssueContextPanel context={issueContext} loading={graphLoading} />
      {loading ? <div className="console-specialists-detail-empty">Loading chain…</div> : null}
      {error ? <div className="console-specialists-detail-empty">{error}</div> : null}
      <div className="console-specialists-section-label">Runs</div>
      <div className="console-specialists-jobs">
        {detailJobs.map((job) => <JobBlock key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} />)}
      </div>
    </section>
  );
}

function IssueContextPanel({ context, loading }: { context?: ChainIssueContext; loading: boolean }) {
  if (loading) return <div className="console-specialists-context-empty">Loading issue context...</div>;
  if (!context || (context.touched.length === 0 && context.related.length === 0)) {
    return <div className="console-specialists-context-empty">No graph context for this chain</div>;
  }

  return (
    <div className="console-specialists-context-panel">
      <div className="console-specialists-section-label">Issue context</div>
      {context.touched.length > 0 ? (
        <div className="console-specialists-context-group">
          <span className="console-specialists-context-label">Touched</span>
          <div className="console-specialists-context-chips">
            {context.touched.map((node) => <IssueContextChip key={node.id} node={node} />)}
          </div>
        </div>
      ) : null}
      {context.related.length > 0 ? (
        <div className="console-specialists-context-group">
          <span className="console-specialists-context-label">Related</span>
          <div className="console-specialists-context-chips">
            {context.related.map((item) => <IssueContextChip key={`${item.edge.type}:${item.direction}:${item.node.id}`} node={item.node} relation={item.edge.type} />)}
          </div>
          <div className="console-specialists-context-legend">
            {[...new Set(context.related.map((item) => item.edge.type))].map((type) => <span key={type}>{RELATIONSHIP_LABEL[type] ?? type}</span>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BeadContractPanel({ issue, loading, error, fallbackId }: { issue: BeadIssueDetail | null; loading: boolean; error: string | null; fallbackId: string }) {
  const hasBody = Boolean(issue?.description?.trim() || issue?.notes?.trim());
  return (
    <details className="console-specialists-contract">
      <summary>
        <span className="console-specialists-contract-title">
          <ChevronRightIcon size={12} className="console-specialists-contract-closed" />
          <ChevronDownIcon size={12} className="console-specialists-contract-open" />
          <span>Bead contract</span>
        </span>
        <span className="console-specialists-contract-meta">
          {loading ? "loading" : issue ? `${issue.id} / P${issue.priority} ${issue.issue_type}` : error ? "unavailable" : `not linked / ${fallbackId}`}
        </span>
      </summary>
      {loading ? (
        <div className="console-specialists-contract-empty">Loading contract...</div>
      ) : issue ? (
        <div className="console-specialists-contract-body">
          <div className="console-specialists-contract-head">
            <span className="console-specialists-contract-id">{issue.id}</span>
            <span className="console-specialists-contract-name">{issue.title}</span>
            <span className={`console-specialists-contract-state status-${statusClass(issue.status)}`}>{issue.status}</span>
          </div>
          <div className="console-specialists-contract-strip">
            <span>P{issue.priority}</span>
            <span>{issue.issue_type}</span>
            {issue.owner ? <span>{issue.owner}</span> : null}
            {issue.dependencies.length > 0 ? <span>{issue.dependencies.length} deps</span> : null}
            {issue.labels.slice(0, 3).map((label) => <span key={label}>{label}</span>)}
          </div>
          {hasBody ? (
            <div className="console-specialists-contract-markdown">
              {issue.description?.trim() ? <ResultMarkdown text={issue.description} /> : null}
              {issue.notes?.trim() ? <ResultMarkdown text={issue.notes} /> : null}
            </div>
          ) : (
            <div className="console-specialists-contract-empty">No description or notes stored for this bead.</div>
          )}
        </div>
      ) : (
        <div className="console-specialists-contract-empty">No bead contract found for this chain.</div>
      )}
    </details>
  );
}

function EmptyState() {
  return <section className="console-specialists-detail console-specialists-detail-empty-state"><div className="console-specialists-empty-mark"><DotFillIcon size={10} /></div><div>Select a chain to see details</div></section>;
}

function openBead(beadId: string, issue: BeadIssueDetail | null = null): void {
  beadSideDrawer.open({ beadId, issue, tab: "activity" });
}

function JobBlock({ job }: { job: ChainJob }) {
  const statusKey = (job.status in STATUS_ICON ? (job.status as StatusKey) : "done");
  const Icon = STATUS_ICON[statusKey];
  const palette = STATUS_COLOR[job.status] ?? STATUS_COLOR.done;
  const role = job.specialist ?? job.chainKind ?? "unknown";
  const idTail = (job.jobId ?? job.beadId).slice(0, 8);
  const isLive = job.status === "starting" || job.status === "running" || job.status === "waiting";
  const [expanded, setExpanded] = useState(isLive);
  const [feedText, setFeedText] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [feedEvents, setFeedEvents] = useState<FeedEventPayload[] | null>(null);
  const feedJobId = job.jobId ?? null;
  const terminalText = (feedText?.trim() || job.lastOutput?.trim() || "").trim();
  const resultText = (result?.text?.trim() || job.lastOutput?.trim() || "").trim();
  const feedLineCount = terminalText ? terminalText.split(/\r?\n/).length : 0;

  useEffect(() => {
    setExpanded(isLive);
  }, [feedJobId, isLive]);

  useEffect(() => {
    if (!feedJobId) {
      setFeedText(null);
      setFeedError(null);
      setFeedLoading(false);
      return;
    }

    const jobId = feedJobId;
    let cancelled = false;
    let timer: number | null = null;
    let controller = new AbortController();

    async function load() {
      controller.abort();
      controller = new AbortController();
      setFeedLoading(true);
      try {
        const res = await fetch(`/api/specialists/jobs/${encodeURIComponent(jobId)}/feed`, { signal: controller.signal });
        if (!res.ok) throw new Error(`feed ${res.status}`);
        const data = (await res.json()) as { text?: string };
        if (cancelled) return;
        setFeedText(data.text ?? "");
        setFeedError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setFeedError(err instanceof Error ? err.message : "feed unavailable");
      } finally {
        if (!cancelled) setFeedLoading(false);
      }
    }

    function schedule() {
      if (!isLive || cancelled) return;
      timer = window.setTimeout(() => {
        void load().then(schedule);
      }, 5000);
    }

    void load().then(schedule);

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [feedJobId, isLive]);

  useEffect(() => {
    if (!feedJobId) {
      setResult(null);
      setResultError(null);
      setResultLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setResultLoading(true);

    void fetch(`/api/specialists/jobs/${encodeURIComponent(feedJobId)}/result`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`result ${res.status}`);
        return await res.json() as ResultPayload;
      })
      .then((payload) => {
        if (cancelled) return;
        setResult(payload);
        setResultError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setResultError(err instanceof Error ? err.message : "result unavailable");
      })
      .finally(() => {
        if (!cancelled) setResultLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [feedJobId]);

  useEffect(() => {
    if (!feedJobId) {
      setFeedEvents(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    void fetch(`/api/specialists/jobs/${encodeURIComponent(feedJobId)}/feed-events`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        const payload = await res.json() as { events?: unknown };
        return Array.isArray(payload.events) ? payload.events.filter(isFeedEventPayload) : null;
      })
      .then((events) => {
        if (cancelled) return;
        setFeedEvents(events);
      })
      .catch(() => {
        if (!cancelled) setFeedEvents(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [feedJobId]);

  return (
    <article
      className={`console-specialists-job-block status-${statusKey}${isLive ? " is-live" : ""}`}
      style={{ ["--rail-color" as string]: palette.fg }}
    >
      <header className="console-specialists-job-header">
        <span className="console-specialists-job-chip" style={{ color: palette.fg, background: palette.bg }}>
          <Icon size={10} />
          <span className="console-specialists-job-chip-role">{role}</span>
          <span className="console-specialists-job-chip-sep">/</span>
          <span className="console-specialists-job-chip-id">{idTail}</span>
        </span>
        <span className="console-specialists-job-meta">
          <span>{formatElapsed(job.updatedAt)}</span>
          {job.turns !== null ? (
            <>
              <span className="console-specialists-card-sep">·</span>
              <span>{job.turns} turns</span>
            </>
          ) : null}
          {job.tools !== null ? (
            <>
              <span className="console-specialists-card-sep">·</span>
              <span>{job.tools} tools</span>
            </>
          ) : null}
          {job.model ? (
            <>
              <span className="console-specialists-card-sep">·</span>
              <span>{job.model}</span>
            </>
          ) : null}
        </span>
      </header>
      <button
        type="button"
        className="console-specialists-job-feed-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        disabled={!feedJobId && !terminalText}
      >
        <span className="console-specialists-job-feed-main">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          <span>terminal feed</span>
        </span>
        <span className="console-specialists-job-feed-meta">
          {feedError ? feedError : feedLoading && !terminalText ? "loading" : terminalText ? `${feedLineCount} lines` : "no feed"}
        </span>
      </button>
      {expanded ? (
        <TerminalFeedTranscript
          className={`console-specialists-job-terminal${isLive ? " is-live" : ""}`}
          text={terminalText}
          status={<TerminalStatus role={role} status={job.status} source={feedText ? "sp feed" : job.lastOutput ? "last output" : "empty"} live={isLive} />}
        />
      ) : !feedJobId && terminalText ? (
        <pre className="console-specialists-job-output">{terminalText}</pre>
      ) : !terminalText ? (
        <div className="console-specialists-job-output console-specialists-job-output-empty">— no terminal feed —</div>
      ) : null}
      <ForensicFeedTimeline events={feedEvents} />
      <RunResultPanel text={resultText} loading={resultLoading && !resultText} error={resultError} />
    </article>
  );
}

function TerminalFeedTranscript({ className, text, status }: { className: string; text: string; status: ReactNode }) {
  return (
    <section className={`terminal-stream ${className}`} aria-label="terminal stream">
      <div className="terminal-stream-status">{status}</div>
      <pre className="console-specialists-job-terminal-text">{stripAnsi(text)}</pre>
    </section>
  );
}

function RunResultPanel({ text, loading, error }: { text: string; loading: boolean; error: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const resultLineCount = countLines(text);

  return (
    <section className="console-specialists-job-result">
      <button
        type="button"
        className="console-specialists-job-feed-toggle console-specialists-job-result-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        disabled={!text}
      >
        <span className="console-specialists-job-feed-main">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          <span>run result</span>
        </span>
        <span className="console-specialists-job-feed-meta">
          {loading ? "loading" : error && !text ? error : text ? `${resultLineCount} lines` : "empty"}
        </span>
      </button>
      {expanded && text ? (
        <div className="console-specialists-job-result-body"><ResultMarkdown text={text} /></div>
      ) : !text ? (
        <div className="console-specialists-job-result-empty">{loading ? "Loading result..." : "No run result captured."}</div>
      ) : (
        null
      )}
    </section>
  );
}

function TerminalStatus({ role, status, source, live }: { role: string; status: string; source: string; live: boolean }) {
  return (
    <span className="console-specialists-job-terminal-status">
      <span className={live ? "is-live" : ""} />
      <b>{role}</b>
      <i>{status}</i>
      <em>{source}</em>
    </span>
  );
}

function ForensicFeedTimeline({ events }: { events: FeedEventPayload[] | null }) {
  if (!events || events.length === 0) return null;

  return (
    <section className="console-specialists-job-forensic" aria-label="forensic events">
      <div className="console-specialists-job-forensic-head">forensic events</div>
      <div className="console-specialists-job-forensic-list">
        {events.map((event, index) => (
          <div key={`${event.schema_version ?? "v"}:${event.event_family ?? "family"}:${event.event_name ?? "event"}:${index}`} className="console-specialists-job-forensic-row">
            <span className="console-specialists-job-forensic-schema">v{String(event.schema_version ?? "?")}</span>
            <span className="console-specialists-job-forensic-family">{event.event_family ?? "unknown"}/{event.event_name ?? "unknown"}</span>
            <span className="console-specialists-job-forensic-meta">{formatForensicParticipant(event.resource?.participant_kind, event.resource?.participant_role)}</span>
            <span className="console-specialists-job-forensic-meta">job:{event.correlation?.job_id ?? "—"}</span>
            <span className="console-specialists-job-forensic-redaction">{event.redaction?.status ?? "unredacted"}</span>
            <span className="console-specialists-job-forensic-meta">{formatEvidenceRefs(event.body?.evidence_refs)}</span>
            {event.trace?.trace_id || event.trace?.span_id ? <span className="console-specialists-job-forensic-meta">trace</span> : null}
            {event.links?.length ? <span className="console-specialists-job-forensic-meta">links:{event.links.length}</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function formatEvidenceRefs(refs?: FeedEvidenceRef[]): string {
  if (!refs || refs.length === 0) return "evidence: —";
  return `evidence: ${refs.map((ref) => `${ref.kind ?? "ref"}:${ref.id ?? ref.evidence_id ?? ref.sha ?? ref.number ?? "unknown"}`).join(", ")}`;
}

function formatForensicParticipant(kind?: string, role?: string): string {
  if (kind && role) return `${kind}/${role}`;
  return kind ?? role ?? "—";
}

function useBeadContract(projectId: string | null, beadId: string | null): { issue: BeadIssueDetail | null; loading: boolean; error: string | null } {
  const [issue, setIssue] = useState<BeadIssueDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIssue(null);
    setError(null);
    if (!projectId || !beadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void substrateApi.getIssue(projectId, beadId).then((nextIssue) => {
      if (cancelled) return;
      setIssue(nextIssue);
      setError(nextIssue ? null : "not found");
    }).catch((loadError) => {
      if (cancelled) return;
      setError(loadError instanceof Error ? loadError.message : "contract unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, beadId]);

  return { issue, loading, error };
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function countLines(value: string): number {
  if (!value.trim()) return 0;
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function excerpt(value: string | null): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
}
