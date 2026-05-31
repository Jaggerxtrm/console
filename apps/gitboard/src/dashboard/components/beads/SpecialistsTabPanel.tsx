import { useEffect, useMemo, useRef } from "react";
import { useInFlightJobs } from "../../hooks/useInFlightJobs.ts";
import { useShellStore, selectDrawerSpecialistsScope, selectSelection } from "../../stores/shell.ts";
import { logClientEvent } from "../../lib/client-log.ts";
import type { SpecialistJob } from "../../../server/observability/types.ts";

const LIVE_STATUSES = new Set(["starting", "running", "waiting"]);

export function SpecialistsTabPanel() {
  const { jobs, sourceEpoch, loading, error } = useInFlightJobs();
  const selection = useShellStore(selectSelection);
  const scope = useShellStore(selectDrawerSpecialistsScope);
  const setScope = useShellStore((s) => s.setDrawerSpecialistsScope);
  const selectedRepo = selection.repo;
  const visibleJobs = useMemo(() => (scope === "all-hosts" || !selectedRepo ? jobs : jobs.filter((job) => job.repoSlug === selectedRepo)), [jobs, scope, selectedRepo]);
  const openedRef = useRef(false);
  const renderedRef = useRef<string>("");

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    logClientEvent("drawer.specialists.tab.opened", { rowCount: visibleJobs.length, scope });
  }, [scope, visibleJobs.length]);

  useEffect(() => {
    if (renderedRef.current) return;
    renderedRef.current = "sampled";
    logClientEvent("drawer.specialists.row.rendered", { rowCount: visibleJobs.length, sourceEpoch });
  }, [sourceEpoch, visibleJobs.length]);

  const handleScopeToggle = () => {
    const next = scope === "all-hosts" ? "repo" : "all-hosts";
    logClientEvent("drawer.specialists.repo_scope.toggled", { from: scope, to: next, rowCountAfter: next === "all-hosts" || !selectedRepo ? jobs.length : jobs.filter((job) => job.repoSlug === selectedRepo).length });
    setScope(next);
  };

  const handleRowOpen = (job: SpecialistJob) => {
    logClientEvent("drawer.specialists.chip.clicked", { jobId: job.jobId, beadId: job.beadId, target: "sidebar" });
    useShellStore.getState().openSidebar({ beadId: job.beadId, jobId: job.jobId ?? undefined });
  };

  if (error) return <div className="drawer-panel-message">{error}</div>;
  if (loading && visibleJobs.length === 0) return <div className="drawer-panel-message">Loading specialists…</div>;

  return (
    <div className="drawer-specialists">
      <div className="drawer-specialists-toolbar">
        <div className="drawer-specialists-scope">{scope === "all-hosts" ? "all hosts" : selectedRepo ?? "current repo"}</div>
        <button type="button" className={scope === "all-hosts" ? "drawer-specialists-scope-toggle is-active" : "drawer-specialists-scope-toggle"} onClick={handleScopeToggle}>
          all hosts
        </button>
      </div>
      <div className="drawer-specialists-empty">{visibleJobs.length === 0 ? "no specialist jobs" : `${visibleJobs.length} jobs`}</div>
      <div className="drawer-specialists-rows">
        {visibleJobs.map((job) => <SpPsRow key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} onOpen={handleRowOpen} />)}
      </div>
    </div>
  );
}

function SpPsRow({ job, onOpen }: { job: SpecialistJob; onOpen: (job: SpecialistJob) => void; }) {
  const specialistLabel = formatSpecialist(job);
  const jobIdLabel = formatJobId(job);
  const previewLabel = formatPreview(job.lastOutput);

  return (
    <div className={LIVE_STATUSES.has(job.status) ? "drawer-specialists-row is-live" : "drawer-specialists-row"}>
      <button type="button" className="drawer-specialists-chip drawer-specialists-chip-role" onClick={() => onOpen(job)} title={specialistLabel}>
        {specialistLabel}
      </button>
      <button type="button" className="drawer-specialists-chip drawer-specialists-chip-id" onClick={() => onOpen(job)} title={jobIdLabel}>
        {jobIdLabel}
      </button>
      <span className="drawer-specialists-status">{job.status}</span>
      <span className="drawer-specialists-elapsed">{formatElapsed(job.updatedAt)}</span>
      <span className="drawer-specialists-preview" title={previewLabel}>{previewLabel}</span>
    </div>
  );
}

function formatSpecialist(job: SpecialistJob): string {
  return job.specialist ?? job.chainKind ?? "unknown";
}

function formatJobId(job: SpecialistJob): string {
  return shortId(job.jobId ?? job.beadId);
}

function formatPreview(lastOutput: string | null): string {
  return lastOutput?.split("\n").at(-1) ?? "—";
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
