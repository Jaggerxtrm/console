import type { KeyboardEvent } from "react";
import { useSpecialistOwnership, type SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";

interface SpecialistOwnerBadgeProps {
  job: SpecialistOwnershipJob;
  onClick?: () => void;
}

const VISIBLE_STATES = new Set(["starting", "running", "waiting", "error", "cancelled"]);

export function SpecialistOwnerBadgeForBead({ beadId }: { beadId: string }) {
  const job = useSpecialistOwnership(beadId);
  if (!job) return null;
  if (!VISIBLE_STATES.has(job.state)) return null;
  return <SpecialistOwnerBadge job={job} />;
}

export function SpecialistOwnerBadge({ job, onClick }: SpecialistOwnerBadgeProps) {
  const jobId = job.jobId ? job.jobId.slice(0, 6) : "—";
  const label = `${job.role}:${jobId}·${job.state}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!onClick) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    }
  };

  return (
    <span
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`specialist-owner-badge state-${job.state}${onClick ? " is-clickable" : ""}`}
      title={`${job.role} job ${job.jobId ?? ""} · ${job.state} · ${job.repoSlug}`}
      onClick={(event) => {
        if (!onClick) return;
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={handleKeyDown}
    >
      {label}
    </span>
  );
}
