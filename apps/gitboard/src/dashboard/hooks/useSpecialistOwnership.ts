import { useEffect, useState } from "react";

export interface SpecialistOwnershipJob {
  role: string;
  state: string;
  repoSlug: string;
}

export function useSpecialistOwnership(beadId: string | null, enabled = true): SpecialistOwnershipJob | null {
  const [job, setJob] = useState<SpecialistOwnershipJob | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!enabled || !beadId) {
        setJob(null);
        return;
      }

      try {
        const res = await fetch(`/api/specialists/jobs?bead_id=${encodeURIComponent(beadId)}`);
        if (!res.ok) {
          if (!cancelled) setJob(null);
          return;
        }

        const data = (await res.json()) as { jobs?: Array<{ specialist?: string | null; status?: string; chainKind?: string | null; repoSlug?: string }> };
        const live = data.jobs?.find((j) => j.status === "running" || j.status === "starting") ?? data.jobs?.[0];
        if (!cancelled) {
          const role = live?.specialist || live?.chainKind || null;
          setJob(role && live?.status && live.repoSlug ? { role, state: live.status, repoSlug: live.repoSlug } : null);
        }
      } catch {
        if (!cancelled) setJob(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [beadId, enabled]);

  return job;
}
