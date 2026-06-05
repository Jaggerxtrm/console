import { useCallback, useEffect, useRef, useState } from "react";

export interface SpecialistOwnershipJob {
  role: string;
  state: string;
  repoSlug: string;
  jobId: string | null;
}

const POLL_MS = 5_000;

export function useSpecialistOwnership(beadId: string | null, enabled = true): SpecialistOwnershipJob | null {
  const [job, setJob] = useState<SpecialistOwnershipJob | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;
    if (!enabled || !beadId) {
      setJob(null);
      return;
    }

    try {
      const res = await fetch(`/api/specialists/jobs?bead_id=${encodeURIComponent(beadId)}`);
      if (!res.ok) {
        if (isCurrent()) setJob(null);
        return;
      }

      const data = (await res.json()) as { jobs?: Array<{ jobId?: string | null; specialist?: string | null; status?: string; chainKind?: string | null; repoSlug?: string }> };
      // Prefer a currently-live job; otherwise surface the most recent terminal error/cancelled
      // for traceability ("which specialist failed on this bead"). Skip 'done' — successful past
      // runs belong in the per-bead history view (forge-4hmt), not the chip.
      const live = data.jobs?.find((j) => j.status === "running" || j.status === "starting" || j.status === "waiting");
      const fallback = !live ? data.jobs?.find((j) => j.status === "error" || j.status === "cancelled") : undefined;
      const chosen = live ?? fallback;
      if (isCurrent()) {
        const role = chosen?.specialist || chosen?.chainKind || null;
        setJob(role && chosen?.status && chosen.repoSlug ? { role, state: chosen.status, repoSlug: chosen.repoSlug, jobId: chosen.jobId ?? null } : null);
      }
    } catch {
      if (isCurrent()) setJob(null);
    }
  }, [beadId, enabled]);

  useEffect(() => {
    void load();
    timerRef.current = window.setInterval(() => { void load(); }, POLL_MS);
    return () => {
      requestIdRef.current += 1;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [load]);

  return job;
}
