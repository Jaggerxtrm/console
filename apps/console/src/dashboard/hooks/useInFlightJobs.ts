import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SpecialistJob } from "../../types/specialists.ts";
import { logClientEvent } from "../lib/client-log.ts";

interface InFlightJobsResponse {
  jobs?: LiveJob[];
  in_flight?: LiveJob[];
  epoch?: Record<string, number>;
  freshness?: string;
  source_health?: { status?: string; message?: string };
}

const POLL_FAST_MS = 0;
const POLL_SLOW_MS = 5000;

export type LiveJob = SpecialistJob & { lastOutput?: string | null; lastEventAt?: string | null };

export interface InFlightGroup {
  repoSlug: string;
  jobs: LiveJob[];
}

export interface UseInFlightJobsState {
  jobs: LiveJob[];
  groups: InFlightGroup[];
  sourceEpoch: Record<string, number>;
  loading: boolean;
  error: string | null;
}

export function useInFlightJobs(): UseInFlightJobsState {
  const [jobs, setJobs] = useState<LiveJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceEpoch, setSourceEpoch] = useState<Record<string, number>>({});
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const epochRef = useRef<Record<string, number>>({});
  const jobsRef = useRef<LiveJob[]>([]);
  const signatureRef = useRef<string>("");

  const load = useCallback(async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch("/api/specialists/jobs/in-flight");
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      const data = (await res.json()) as InFlightJobsResponse;
      if (!aliveRef.current) return;

      const nextEpoch = data.epoch ?? {};
      const changed = hasEpochChanged(epochRef.current, nextEpoch);
      const receivedJobs = data.jobs ?? data.in_flight ?? [];
      const isStaleEmpty = data.freshness === "stale" && receivedJobs.length === 0 && jobsRef.current.length > 0;
      const nextJobs = isStaleEmpty ? jobsRef.current : receivedJobs;
      const signature = jobsSignature(nextJobs, nextEpoch);
      if (changed || signatureRef.current !== signature || isStaleEmpty) {
        signatureRef.current = signature;
        logClientEvent("specialists.in_flight.received", {
          ms: Math.round(performance.now() - startedAt),
          jobs: nextJobs.length,
          receivedJobs: receivedJobs.length,
          preserved: isStaleEmpty,
          freshness: data.freshness ?? "unknown",
          sourceStatus: data.source_health?.status ?? null,
          changed,
          beadIds: [...new Set(nextJobs.map((job) => job.beadId))].slice(0, 50),
          repoSlugs: [...new Set(nextJobs.map((job) => job.repoSlug))].slice(0, 50),
          jobIds: nextJobs.slice(0, 50).map((job) => job.jobId),
          statuses: countJobStatuses(nextJobs),
          epoch: nextEpoch,
        });
      }
      epochRef.current = nextEpoch;
      jobsRef.current = nextJobs;
      setSourceEpoch(nextEpoch);
      setJobs(nextJobs);
      setError(null);
      setLoading(false);
      schedule(load, timerRef, changed ? POLL_FAST_MS : POLL_SLOW_MS);
    } catch (err) {
      if (!aliveRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load in-flight jobs";
      logClientEvent("specialists.in_flight.error", {
        ms: Math.round(performance.now() - startedAt),
        message,
      });
      setError(message);
      setLoading(false);
      schedule(load, timerRef, POLL_SLOW_MS);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  const groups = useMemo(() => groupJobsByRepo(jobs), [jobs]);
  return { jobs, groups, sourceEpoch, loading, error };
}

function schedule(load: () => Promise<void>, timerRef: MutableRefObject<number | null>, delayMs: number): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
  }
  timerRef.current = window.setTimeout(() => {
    void load();
  }, delayMs);
}

function hasEpochChanged(prev: Record<string, number>, next: Record<string, number>): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    if (prev[key] !== next[key]) return true;
  }
  return false;
}

function groupJobsByRepo(jobs: LiveJob[]): InFlightGroup[] {
  const groups = new Map<string, LiveJob[]>();
  for (const job of jobs) {
    const bucket = groups.get(job.repoSlug);
    if (bucket) bucket.push(job);
    else groups.set(job.repoSlug, [job]);
  }
  return [...groups.entries()].map(([repoSlug, groupedJobs]) => ({ repoSlug, jobs: groupedJobs }));
}

function jobsSignature(jobs: LiveJob[], epoch: Record<string, number>): string {
  return JSON.stringify({
    jobs: jobs.map((job) => [job.jobId, job.beadId, job.repoSlug, job.status, job.updatedAt, job.lastEventAt]),
    epoch,
  });
}

function countJobStatuses(jobs: LiveJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return counts;
}
