import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { logClientEvent } from "../../lib/client-log.ts";
import type { SpecialistJob } from "../../../server/observability/types.ts";
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

export function BeadActivityPane({ beadId, jobIdHint }: BeadActivityPaneProps) {
  const [jobs, setJobs] = useState<SpecialistJob[]>([]);
  const [headerIssue, setHeaderIssue] = useState<SpecialistJob | null>(null);
  const [results, setResults] = useState<Record<string, ResultPayload | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    logClientEvent("bead_activity.mount", { beadId, jobIdHint });
    return () => logClientEvent("bead_activity.unmount", { beadId, jobIdHint });
  }, [beadId, jobIdHint]);

  useEffect(() => {
    let cancelled = false;
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
      }
    }
    void loadJobs();
    return () => { cancelled = true; };
  }, [beadId]);

  const chains = useMemo(() => groupJobsByChain(jobs, jobIdHint), [jobIdHint, jobs]);

  useEffect(() => {
    const completedJobs = jobs.filter((job) => isFinished(job.status));
    for (const job of completedJobs) {
      const key = job.jobId ?? job.beadId;
      if (loadedRef.current.has(key)) continue;
      loadedRef.current.add(key);
      void loadResult(job).then((payload) => {
        setResults((current) => ({ ...current, [key]: payload }));
        logClientEvent("bead_activity.result.rendered", { beadId, jobId: key });
      }).catch((resultError) => {
        logClientEvent("bead_activity.result.fetch.error", { beadId, jobId: key, error: resultError instanceof Error ? resultError.message : String(resultError) });
      });
    }
  }, [beadId, jobs]);

  if (error) return <div className="bead-activity-error">{error}</div>;
  if (jobs.length === 0) return <BeadHeader issue={headerIssueToIssue(beadId, headerIssue)} detail={null} />;

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
                  setExpanded((current) => ({ ...current, [key]: next }));
                  logClientEvent(next ? "bead_activity.feed.expand" : "bead_activity.feed.collapse", { beadId, jobId: key });
                }}
                result={results[job.jobId ?? job.beadId]}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function JobBlock({ job, expanded, onToggle, result }: { job: SpecialistJob; expanded: boolean; onToggle: () => void; result?: ResultPayload; }) {
  const state = jobFeedState(job, expanded);
  const jobKey = job.jobId ?? job.beadId;
  const isRunning = state === "running";
  return (
    <article className="bead-activity-job">
      <button type="button" className="bead-activity-job-row" onClick={onToggle} aria-expanded={expanded}>
        <div>{job.beadId} / {job.specialist ?? job.chainKind ?? job.beadId}</div>
        <div>{job.specialist ?? job.chainKind ?? "—"} / {jobKey}</div>
      </button>
      {isRunning ? (
        <TerminalStream className="bead-activity-terminal" />
      ) : (
        <div className="bead-activity-feed">
          <button type="button" className="bead-activity-toggle" onClick={onToggle}>{expanded ? "▾ hide feed" : "▸ show feed"}</button>
          {expanded ? <TerminalStream className="bead-activity-terminal" /> : null}
          {result ? <ResultMarkdown text={result.text} /> : null}
        </div>
      )}
    </article>
  );
}

async function loadResult(job: SpecialistJob): Promise<ResultPayload | undefined> {
  const jobId = job.jobId ?? job.beadId;
  const res = await fetch(`/api/specialists/jobs/${encodeURIComponent(jobId)}/result`);
  if (!res.ok) throw new Error(`result ${res.status}`);
  return await res.json() as ResultPayload;
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
