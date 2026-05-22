export const SOURCE_HEALTH_STATUSES = ["fresh", "stale", "degraded", "unhealthy", "missing"] as const;

export type SourceHealthStatus = typeof SOURCE_HEALTH_STATUSES[number];
export type SourceHealthFreshness = Extract<SourceHealthStatus, "fresh" | "stale" | "degraded">;
export type SourceHealthSource = "graph" | "beads" | "specialists" | "github";

export interface SourceHealth {
  source: SourceHealthSource;
  status: SourceHealthStatus;
  checked_at: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export function makeSourceHealth(source: SourceHealthSource, status: SourceHealthStatus, options: Omit<Partial<SourceHealth>, "source" | "status"> = {}): SourceHealth {
  return { source, status, checked_at: options.checked_at ?? new Date().toISOString(), ...(options.message ? { message: options.message } : {}), ...(options.metadata ? { metadata: options.metadata } : {}) };
}

export function freshnessFromSourceHealth(status: SourceHealthStatus): SourceHealthFreshness {
  if (status === "fresh" || status === "stale" || status === "degraded") return status;
  return "degraded";
}
