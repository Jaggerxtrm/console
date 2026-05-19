import { AlertIcon, CheckIcon, ClockIcon, DotFillIcon, PlayIcon, XCircleIcon } from "@primer/octicons-react";
import { useShellStore } from "../../../stores/shell.ts";
import type { ChainJob, ChainSummary } from "../../../hooks/useChains.ts";
import { useChainDetail } from "../../../hooks/useChainDetail.ts";

const STATUS_ICON = {
  running: PlayIcon,
  waiting: ClockIcon,
  done: CheckIcon,
  error: AlertIcon,
  cancelled: XCircleIcon,
} as const;

export function ChainDetailPane({ chain }: { chain: ChainSummary | null }) {
  const setDrawerOpen = useShellStore((state) => state.setDrawerOpen);
  const setDrawerTab = useShellStore((state) => state.setDrawerTab);
  const { jobs, loading, error } = useChainDetail(chain?.chainId ?? null);

  if (!chain) {
    return <EmptyState />;
  }

  const detailJobs = jobs.length > 0 ? jobs : chain.jobs;
  const latest = detailJobs[detailJobs.length - 1] ?? null;

  return (
    <section className="console-specialists-detail">
      <div className="console-specialists-detail-header">
        <div>
          <div className="console-specialists-detail-id">{chain.rootBeadId}</div>
          <div className="console-specialists-detail-title">{chain.title}</div>
        </div>
        <button type="button" className="console-specialists-open-bead" onClick={() => { setDrawerTab("specialists"); setDrawerOpen(true); }}>Open bead</button>
      </div>
      {loading ? <div className="console-specialists-detail-empty">Loading chain…</div> : null}
      {error ? <div className="console-specialists-detail-empty">{error}</div> : null}
      <div className="console-specialists-timeline">
        {detailJobs.map((job) => <TimelineRow key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} />)}
      </div>
      <section className="console-specialists-detail-block">
        <div className="console-specialists-section-title">Last output</div>
        <div className="console-specialists-last-output">{truncate(latest?.lastOutput ?? null)}</div>
      </section>
    </section>
  );
}

function EmptyState() {
  return <section className="console-specialists-detail console-specialists-detail-empty-state"><div className="console-specialists-empty-mark"><DotFillIcon size={10} /></div><div>Select a chain to see details</div></section>;
}

function TimelineRow({ job }: { job: ChainJob }) {
  const Icon = STATUS_ICON[(job.status as keyof typeof STATUS_ICON) ?? "done"] ?? CheckIcon;
  return <div className="console-specialists-timeline-row"><span className="console-specialists-status"><Icon size={12} /></span><span className="console-specialists-role">{job.specialist ?? job.chainKind ?? "unknown"}</span><span className="console-specialists-job-id">{job.jobId ?? job.beadId}</span><span className="console-specialists-meta">{formatElapsed(job.updatedAt)} · {(job.turns ?? "—")} turns · {(job.tools ?? "—")} tools · {(job.model ?? "—")}</span></div>;
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function truncate(value: string | null): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}…` : text || "—";
}
