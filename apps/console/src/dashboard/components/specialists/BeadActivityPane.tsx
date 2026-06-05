import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { logClientEvent } from "../../lib/client-log.ts";
import type { SpecialistJob } from "../../../types/specialists.ts";
import type { BeadIssue } from "../../../types/beads.ts";
import { TerminalStream } from "../terminal/TerminalStream.tsx";
import { ResultMarkdown } from "../../lib/markdown.tsx";
import { BeadHeader } from "./BeadHeader.tsx";
import { groupJobsByChain, isFinished, jobFeedState, type ResultPayload } from "./beadActivityState.ts";

export type BeadActivityPaneProps = {
  beadId: string;
  jobIdHint?: string | null;
};

type JobsResponse = {
  jobs: SpecialistJob[];
};

const ACTIVITY_POLL_MS = 5000;

export function BeadActivityPane({ beadId, jobIdHint }: BeadActivityPaneProps) {
  const [jobs, setJobs] = useState<SpecialistJob[]>([]);
  const [headerIssue, setHeaderIssue] = useState<SpecialistJob | null>(null);
  const [results, setResults] = useState<Record<string, ResultPayload | undefined>>({});
  const [feeds, setFeeds] = useState<Record<string, string | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedResultsRef = useRef<Set<string>>(new Set());
  const loadedFeedsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    logClientEvent("bead_activity.mount", { beadId, jobIdHint });
    return () => {
      for (const [jobId, isExpanded] of Object.entries(expandedRef.current)) {
        if (isExpanded) logClientEvent("bead_activity.feed.collapse", { beadId, jobId, reason: "unmount" });
      }
      logClientEvent("bead_activity.unmount", { beadId, jobIdHint });
    };
  }, [beadId, jobIdHint]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setJobs([]);
    setHeaderIssue(null);
    setResults({});
    setFeeds({});
    setExpanded({});
    loadedResultsRef.current.clear();
    loadedFeedsRef.current.clear();
    expandedRef.current = {};
    async function loadJobs() {
      try {
        const res = await fetch(`/api/specialists/jobs?bead_id=${encodeURIComponent(beadId)}`);
        if (!res.ok) throw new Error(`jobs ${res.status}`);
        const data = await res.json() as JobsResponse;
        if (cancelled) return;
        setJobs(data.jobs);
        setHeaderIssue(data.jobs[0] ?? null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadJobs();
    const timer = window.setInterval(() => { void loadJobs(); }, ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [beadId]);

  const chains = useMemo(() => groupJobsByChain(jobs, jobIdHint), [jobIdHint, jobs]);

  useEffect(() => {
    for (const job of jobs) {
      const key = job.jobId ?? job.beadId;
      const finished = isFinished(job.status);
      const shouldLoadFeed = !finished || !loadedFeedsRef.current.has(key);
      if (shouldLoadFeed) {
        if (finished) loadedFeedsRef.current.add(key);
        void loadFeed(job).then((feed) => {
          if (feed !== undefined) setFeeds((current) => ({ ...current, [key]: feed }));
          logClientEvent("bead_activity.feed.loaded", { beadId, jobId: key, finished, hasFeed: Boolean(feed) });
        }).catch((feedError) => {
          logClientEvent("bead_activity.feed.fetch.error", { beadId, jobId: key, error: feedError instanceof Error ? feedError.message : String(feedError) });
        });
      }
      if (!finished || loadedResultsRef.current.has(key)) continue;
      loadedResultsRef.current.add(key);
      void loadResult(job).then((payload) => {
        setResults((current) => ({ ...current, [key]: payload }));
        logClientEvent("bead_activity.result.rendered", { beadId, jobId: key, hasResult: Boolean(payload) });
      }).catch((resultError) => {
        logClientEvent("bead_activity.result.fetch.error", { beadId, jobId: key, error: resultError instanceof Error ? resultError.message : String(resultError) });
      });
    }
  }, [beadId, jobs]);

  if (error) return <div className="bead-activity-error" role="alert">{error}</div>;
  if (loading) {
    return (
      <section className="bead-activity-pane" aria-live="polite">
        <BeadHeader issue={headerIssueToIssue(beadId, headerIssue)} detail={null} />
        <div className="bead-activity-loading">Loading specialist activity...</div>
      </section>
    );
  }
  if (jobs.length === 0) {
    return (
      <section className="bead-activity-pane">
        <BeadHeader issue={headerIssueToIssue(beadId, headerIssue)} detail={null} />
        <div className="bead-activity-empty">No specialist activity yet.</div>
      </section>
    );
  }

  return (
    <section className="bead-activity-pane">
      <BeadHeader issue={headerIssueToIssue(beadId, headerIssue)} detail={null} />
      <div className="bead-activity-chains">
        {chains.map((chain) => (
          <div key={chain.chainId} className="bead-activity-chain">
            {chain.jobs.map((job) => (
              <JobBlock
                key={job.jobId ?? job.beadId}
                job={job}
                expanded={expanded[job.jobId ?? job.beadId] ?? false}
                onToggle={() => {
                  const key = job.jobId ?? job.beadId;
                  const next = !(expanded[key] ?? false);
                  setExpanded((current) => {
                    const updated = { ...current, [key]: next };
                    expandedRef.current = updated;
                    return updated;
                  });
                  logClientEvent(next ? "bead_activity.feed.expand" : "bead_activity.feed.collapse", { beadId, jobId: key, reason: "user" });
                }}
                result={results[job.jobId ?? job.beadId]}
                feed={feeds[job.jobId ?? job.beadId]}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function JobBlock({ job, expanded, onToggle, result, feed }: { job: SpecialistJob; expanded: boolean; onToggle: () => void; result?: ResultPayload; feed?: string; }) {
  const state = jobFeedState(job, expanded);
  const jobKey = job.jobId ?? job.beadId;
  const isRunning = state === "running";
  const role = job.specialist ?? job.chainKind ?? "specialist";
  const statusLabel = formatStatus(job.status);
  const updatedLabel = formatUpdatedAt(job.updatedAt);
  const output = terminalOutputForJob(job, result, feed);
  const lineCount = countLines(output[0]);
  const feedStatus = feed ? `${lineCount} lines` : result || job.lastOutput ? "fallback" : "loading";
  return (
    <article className="bead-activity-job">
      <button type="button" className="bead-activity-job-row" onClick={onToggle} aria-expanded={expanded} aria-label={`${role} ${statusLabel} activity for ${job.beadId}`}>
        <div className="bead-activity-job-main">
          <span className={`bead-activity-status bead-activity-status-${statusClass(job.status)}`}>{statusLabel}</span>
          <span className="bead-activity-role">{role}</span>
        </div>
        <div className="bead-activity-job-meta">
          <span>{job.beadId}</span>
          {jobKey !== job.beadId ? <span>{jobKey}</span> : null}
          {job.chainId ? <span>{job.chainId}</span> : null}
          {updatedLabel ? <span>{updatedLabel}</span> : null}
        </div>
      </button>
      {isRunning ? (
        <TerminalStream
          className="bead-activity-terminal is-live"
          output={output}
          readonly
          status={<TerminalStatus mode="live" role={role} status={feed ? "sp feed" : "waiting"} detail={feedStatus} />}
        />
      ) : (
        <div className="bead-activity-feed">
          <button type="button" className="bead-activity-toggle" onClick={onToggle} aria-label={`${expanded ? "collapse" : "expand"} terminal feed for ${role} ${jobKey}`}>
            <span className="bead-activity-toggle-main">
              {expanded ? <ChevronDownIcon size={12} aria-hidden="true" /> : <ChevronRightIcon size={12} aria-hidden="true" />}
              <span>terminal feed</span>
            </span>
            <span className="bead-activity-toggle-meta">{feedStatus}</span>
          </button>
          {expanded ? (
            <TerminalStream
              className="bead-activity-terminal"
              output={output}
              readonly
              status={<TerminalStatus mode="history" role={role} status={feed ? "sp feed" : "snapshot"} detail={feedStatus} />}
            />
          ) : null}
          {result ? <ResultMarkdown text={result.text} /> : null}
        </div>
      )}
    </article>
  );
}

function TerminalStatus({ mode, role, status, detail }: { mode: "live" | "history"; role: string; status: string; detail: string }) {
  return (
    <div className="bead-activity-terminal-status">
      <span className={`bead-activity-terminal-dot is-${mode}`} aria-hidden="true" />
      <span>{mode}</span>
      <span className="bead-activity-terminal-sep">/</span>
      <span>{role}</span>
      <span className="bead-activity-terminal-sep">/</span>
      <span>{status}</span>
      <span className="bead-activity-terminal-fill" />
      <span>{detail}</span>
    </div>
  );
}

async function loadFeed(job: SpecialistJob): Promise<string | undefined> {
  const jobId = job.jobId ?? job.beadId;
  try {
    const res = await fetch(`/api/specialists/jobs/${encodeURIComponent(jobId)}/feed`);
    if (!res.ok) return undefined;
    const payload = await res.json() as { text?: string };
    return payload.text?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function loadResult(job: SpecialistJob): Promise<ResultPayload | undefined> {
  const fallback = resultFromJobOutput(job);
  const jobId = job.jobId ?? job.beadId;
  try {
    const res = await fetch(`/api/specialists/jobs/${encodeURIComponent(jobId)}/result`);
    if (!res.ok) return fallback;
    return await res.json() as ResultPayload;
  } catch {
    return fallback;
  }
}

function resultFromJobOutput(job: SpecialistJob): ResultPayload | undefined {
  const text = job.lastOutput?.trim();
  return text ? { text, content_type: "text/markdown" } : undefined;
}

function terminalOutputForJob(job: SpecialistJob, result?: ResultPayload, feed?: string): readonly string[] {
  const output = feed?.trim() || job.lastOutput?.trim() || result?.text?.trim();
  return output ? [output] : [];
}

function countLines(value: string | undefined): number {
  if (!value?.trim()) return 0;
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function formatStatus(status: string): string {
  return status.replace(/[_-]+/g, " ").trim() || "unknown";
}

function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function formatUpdatedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `updated ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function headerIssueToIssue(beadId: string, job: SpecialistJob | null): BeadIssue {
  return {
    id: beadId,
    title: job?.specialist ?? job?.chainKind ?? beadId,
    description: null,
    status: "open",
    priority: 3,
    issue_type: "task",
    owner: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dependencies: [],
    project_id: "",
    created_by: null,
    related_ids: [],
    labels: [],
  };
}
