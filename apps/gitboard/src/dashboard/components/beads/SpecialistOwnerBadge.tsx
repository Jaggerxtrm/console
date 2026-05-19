import { useSpecialistOwnership, type SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";

interface SpecialistOwnerBadgeProps {
  job: SpecialistOwnershipJob;
}

const LIVE_STATES = new Set(["starting", "running", "waiting"]);

export function SpecialistOwnerBadgeForBead({ beadId }: { beadId: string }) {
  const job = useSpecialistOwnership(beadId);
  if (!job) return null;
  if (!LIVE_STATES.has(job.state)) return null;
  return <SpecialistOwnerBadge job={job} />;
}

const STATE_COLORS: Record<string, string> = {
  starting: "var(--status-blocked)",
  running: "var(--status-open)",
  waiting: "var(--text-muted)",
};

export function SpecialistOwnerBadge({ job }: SpecialistOwnerBadgeProps) {
  const color = STATE_COLORS[job.state] ?? "var(--text-muted)";
  const jobId = job.jobId ? job.jobId.slice(0, 6) : "—";
  const label = `${job.role}:${jobId}·${job.state}`;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 6px",
        borderRadius: 4,
        border: `1px solid ${color}`,
        color,
        fontSize: "inherit",
        lineHeight: "inherit",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono, monospace)",
      }}
      title={`${job.role} job ${job.jobId ?? ""} · ${job.state} · ${job.repoSlug}`}
    >
      {label}
    </span>
  );
}
