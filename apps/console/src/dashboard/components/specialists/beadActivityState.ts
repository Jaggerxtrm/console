import type { SpecialistJob } from "../../../types/specialists.ts";

export type JobState = "running" | "expanded" | "collapsed";

export type ResultPayload = {
  text: string;
  content_type: string;
};

export function jobFeedState(job: SpecialistJob, expanded: boolean): JobState {
  if (job.status === "running" || job.status === "starting" || job.status === "waiting") return "running";
  return expanded ? "expanded" : "collapsed";
}

export function isFinished(status: string): boolean {
  return status === "done" || status === "failed" || status === "error" || status === "cancelled";
}

export function groupJobsByChain(jobs: SpecialistJob[], jobIdHint?: string | null): Array<{ chainId: string; jobs: SpecialistJob[] }> {
  const grouped = new Map<string, SpecialistJob[]>();
  for (const job of jobs) {
    const chainId = job.chainId ?? jobIdHint ?? job.jobId ?? job.beadId;
    const list = grouped.get(chainId) ?? [];
    list.push(job);
    grouped.set(chainId, list);
  }
  return [...grouped.entries()].map(([chainId, chainJobs]) => ({ chainId, jobs: chainJobs }));
}
