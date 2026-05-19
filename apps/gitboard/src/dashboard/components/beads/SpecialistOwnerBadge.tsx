import { useSpecialistOwnership, type SpecialistOwnershipJob } from "../../hooks/useSpecialistOwnership.ts";

interface SpecialistOwnerBadgeProps {
  job: SpecialistOwnershipJob;
}

export function SpecialistOwnerBadgeForBead({ beadId }: { beadId: string }) {
  const job = useSpecialistOwnership(beadId);
  if (!job) return null;
  return <SpecialistOwnerBadge job={job} />;
}

const STATE_COLORS: Record<string, string> = {
  starting: "var(--status-blocked)",
  running: "var(--status-open)",
};

export function SpecialistOwnerBadge({ job }: SpecialistOwnerBadgeProps) {
  const color = STATE_COLORS[job.state] ?? "var(--text-muted)";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        background: "color-mix(in srgb, currentColor 10%, transparent)",
        fontSize: "var(--text-xs)",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 700, textTransform: "capitalize" }}>{job.role}</span>
      <span>·</span>
      <span>{job.state}</span>
      <span>·</span>
      <span>{job.repoSlug}</span>
    </span>
  );
}
