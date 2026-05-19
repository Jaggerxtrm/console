import { useSpecialistOwnership, type SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";

interface SpecialistOwnerBadgeProps {
  job: SpecialistOwnershipJob;
}

const VISIBLE_STATES = new Set(["starting", "running", "waiting", "error", "cancelled"]);

export function SpecialistOwnerBadgeForBead({ beadId }: { beadId: string }) {
  const job = useSpecialistOwnership(beadId);
  if (!job) return null;
  if (!VISIBLE_STATES.has(job.state)) return null;
  return <SpecialistOwnerBadge job={job} />;
}

export function SpecialistOwnerBadge({ job }: SpecialistOwnerBadgeProps) {
  const jobId = job.jobId ? job.jobId.slice(0, 6) : "—";
  const label = `${job.role}:${jobId}·${job.state}`;

  return (
    <span
      className={`specialist-owner-badge state-${job.state}`}
      title={`${job.role} job ${job.jobId ?? ""} · ${job.state} · ${job.repoSlug}`}
    >
      {label}
    </span>
  );
}
