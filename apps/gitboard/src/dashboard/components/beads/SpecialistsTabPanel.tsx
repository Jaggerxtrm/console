import { useMemo, useState, type ReactNode } from "react";
import { useAllSpecialistJobs } from "../../hooks/useAllSpecialistJobs.ts";
import type { SpecialistJob } from "../../../server/observability/types.ts";

const LIVE_STATUSES = new Set(["starting", "running", "waiting"]);
const HISTORY_STATUSES = new Set(["done", "error", "cancelled"]);

export function SpecialistsTabPanel() {
  const { inFlight, history, loading, error } = useAllSpecialistJobs(50);
  const [showMore, setShowMore] = useState(false);

  const recentHistory = useMemo(() => {
    const sorted = [...history].sort((a, b) => Number(new Date(b.updatedAt)) - Number(new Date(a.updatedAt)));
    return showMore ? sorted : sorted.slice(0, 50);
  }, [history, showMore]);

  const liveRows = useMemo(() => inFlight.filter((job) => LIVE_STATUSES.has(job.status)), [inFlight]);
  const historyRows = useMemo(() => recentHistory.filter((job) => HISTORY_STATUSES.has(job.status) || !LIVE_STATUSES.has(job.status)), [recentHistory]);

  if (error) return <div className="drawer-panel-message">{error}</div>;
  if (loading && liveRows.length === 0 && historyRows.length === 0) return <div className="drawer-panel-message">Loading specialists…</div>;

  return (
    <div className="drawer-specialists">
      <Section title={`in_progress (${liveRows.length})`} emptyText="no live specialists" rows={liveRows} />
      <Section
        title={`history (${historyRows.length})`}
        emptyText="no recent runs"
        rows={historyRows}
        footer={history.length > 50 ? (
          <button type="button" className="drawer-show-more" onClick={() => setShowMore((value) => !value)}>
            {showMore ? "show less" : "show more"}
          </button>
        ) : null}
      />
    </div>
  );
}

function Section({ title, rows, emptyText, footer }: { title: string; rows: SpecialistJob[]; emptyText: string; footer?: ReactNode; }) {
  return (
    <section className="drawer-specialists-section">
      <div className="drawer-specialists-header">{title}</div>
      <div className="drawer-specialists-rows">
        {rows.length === 0 ? <div className="drawer-specialists-empty">{emptyText}</div> : rows.map((job) => <JobRow key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} />)}
      </div>
      {footer}
    </section>
  );
}

function JobRow({ job }: { job: SpecialistJob }) {
  return (
    <div className="drawer-specialists-row">
      <span>{shortId(job.jobId)}</span>
      <span>{job.specialist ?? "—"}</span>
      <span>{job.status}</span>
      <span>{job.beadId}</span>
      <span>{job.chainId ?? "—"}</span>
      <span>{job.epicId ?? "—"}</span>
      <span>{job.repoSlug}</span>
      <span>{formatElapsed(job.updatedAt)}</span>
    </div>
  );
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
