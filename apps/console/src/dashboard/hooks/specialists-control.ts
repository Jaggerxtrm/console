import type { SpecialistJob } from "../../types/specialists.ts";

export async function stopJob(jobId: string, options: { force?: boolean } = {}): Promise<UpdatedJob> {
  const response = await fetchJson(`/api/console/specialists/jobs/${encodeURIComponent(jobId)}/stop`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  return response.job;
}

export async function steerJob(jobId: string, message: string): Promise<UpdatedJob> {
  const response = await fetchJson(`/api/console/specialists/jobs/${encodeURIComponent(jobId)}/steer`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return response.job;
}

export async function resumeJob(jobId: string, task: string): Promise<UpdatedJob> {
  const response = await fetchJson(`/api/console/specialists/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ task }),
  });
  return response.job;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ job: UpdatedJob }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `request failed: ${response.status}`);
  }
  return response.json() as Promise<{ job: UpdatedJob }>;
}

export type UpdatedJob = SpecialistJob;
