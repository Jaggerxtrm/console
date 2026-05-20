import { AlertIcon, CheckIcon, ClockIcon, DotFillIcon, PlayIcon, XCircleIcon } from "@primer/octicons-react";
import type { ChainJob, ChainSummary } from "../../../hooks/useChains.ts";
import { useChainDetail } from "../../../hooks/useChainDetail.ts";

const STATUS_ICON = {
  running: PlayIcon,
  waiting: ClockIcon,
  done: CheckIcon,
  error: AlertIcon,
  cancelled: XCircleIcon,
} as const;

type StatusKey = keyof typeof STATUS_ICON;

// Borderless status palette — coloured chip + faint matching background fill,
// so the role/jobId tag reads at a glance like the Feed status marks.
const STATUS_COLOR: Record<string, { fg: string; bg: string }> = {
  running:   { fg: "var(--graph-state-wip)",      bg: "rgba(212, 161, 89, 0.10)" },
  waiting:   { fg: "var(--text-muted)",            bg: "rgba(255, 255, 255, 0.04)" },
  done:      { fg: "var(--graph-state-closed)",   bg: "rgba(72, 159, 110, 0.10)" },
  error:     { fg: "var(--graph-priority-0)",     bg: "rgba(217, 95, 81, 0.10)" },
  cancelled: { fg: "var(--text-muted)",            bg: "rgba(255, 255, 255, 0.04)" },
};

export function ChainDetailPane({ chain }: { chain: ChainSummary | null }) {
  const { jobs, loading, error } = useChainDetail(chain?.chainId ?? null);

  if (!chain) {
    return <EmptyState />;
  }

  const detailJobs = jobs.length > 0 ? jobs : chain.jobs;

  return (
    <section className="console-specialists-detail">
      <div className="console-specialists-detail-header">
        <span className="console-specialists-detail-id">{chain.rootBeadId}</span>
        <span className="console-specialists-card-sep">/</span>
        <span className="console-specialists-detail-title">{chain.title}</span>
        <button type="button" className="console-specialists-open-bead" onClick={() => { void openBead(chain.rootBeadId); }}>[ open bead ↗ ]</button>
      </div>
      {loading ? <div className="console-specialists-detail-empty">Loading chain…</div> : null}
      {error ? <div className="console-specialists-detail-empty">{error}</div> : null}
      <div className="console-specialists-jobs">
        {detailJobs.map((job) => <JobBlock key={`${job.repoSlug}:${job.jobId ?? job.beadId}:${job.updatedAt}`} job={job} />)}
      </div>
    </section>
  );
}

function EmptyState() {
  return <section className="console-specialists-detail console-specialists-detail-empty-state"><div className="console-specialists-empty-mark"><DotFillIcon size={10} /></div><div>Select a chain to see details</div></section>;
}

async function openBead(beadId: string): Promise<void> {
  try {
    const module = await import(/* @vite-ignore */ new URL("../../../hooks/useBeadSideDrawer", import.meta.url).href);
    const hook = module.useBeadSideDrawer?.();
    if (hook?.open) {
      hook.open(beadId);
      return;
    }
  } catch {
    /* fallback below */
  }

  try {
    window.history.pushState({}, "", "/gitboard/console/feed");
    const target = document.querySelector(`[data-bead-id=\"${CSS.escape(beadId)}\"]`);
    target?.scrollIntoView({ block: "center" });
  } catch {
    // ignore fallback failures
  }
}

function JobBlock({ job }: { job: ChainJob }) {
  const statusKey = (job.status in STATUS_ICON ? (job.status as StatusKey) : "done");
  const Icon = STATUS_ICON[statusKey];
  const palette = STATUS_COLOR[job.status] ?? STATUS_COLOR.done;
  const role = job.specialist ?? job.chainKind ?? "unknown";
  const idTail = (job.jobId ?? job.beadId).slice(0, 8);
  const isLive = job.status === "running";
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
          <span className="console-specialists-card-sep">·</span>
          <span>{job.turns ?? "—"}t</span>
          <span className="console-specialists-card-sep">·</span>
          <span>{job.tools ?? "—"} tools</span>
          {job.model ? (
            <>
              <span className="console-specialists-card-sep">·</span>
              <span>{job.model}</span>
            </>
          ) : null}
        </span>
      </header>
      {job.lastOutput ? (
        <pre className="console-specialists-job-output">{job.lastOutput}</pre>
      ) : (
        <div className="console-specialists-job-output console-specialists-job-output-empty">— no output —</div>
      )}
    </article>
  );
}

function formatElapsed(updatedAt: string): string {
  const delta = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(delta) || delta < 0) return "now";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
