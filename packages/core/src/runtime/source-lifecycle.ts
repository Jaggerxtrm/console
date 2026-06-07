import type { SourceHealth } from "../state/source-health.ts";

export type SourceLifecycleKind = "beads" | "observability" | "github";
export type SourceLifecycleStatus = "active" | "idle" | "degraded" | "missing";
export type SourceLifecycleEvent = "source.discovered" | "source.attached" | "source.skipped" | "source.degraded" | "source.health.changed";

export interface SourceDescriptor {
  sourceKey: string;
  kind: SourceLifecycleKind;
  repoSlug: string;
  displayPath: string;
  status: SourceLifecycleStatus;
  health: SourceHealth;
  metadata?: Record<string, unknown>;
}

export interface SourceLifecycleLogEntry {
  event: SourceLifecycleEvent;
  sourceKey?: string;
  repoSlug?: string;
  level: "debug" | "info" | "warn" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export interface SourceDiscoveryService {
  discover(): SourceDescriptor[] | Promise<SourceDescriptor[]>;
}

export interface SourceHealthService {
  getSourceHealth(sourceKey: string): SourceHealth | null | Promise<SourceHealth | null>;
}

export interface SourceLifecycleHooks {
  emitLog?: (entry: SourceLifecycleLogEntry) => void;
  publishHealthHint?: (source: SourceDescriptor) => void;
}

export function summarizeSourceHealth(sources: readonly SourceDescriptor[]): { total: number; degraded: number; missing: number; healthy: number } {
  return sources.reduce((summary, source) => {
    summary.total += 1;
    if (source.health.status === "missing") summary.missing += 1;
    else if (source.health.status === "degraded" || source.health.status === "unhealthy") summary.degraded += 1;
    else summary.healthy += 1;
    return summary;
  }, { total: 0, degraded: 0, missing: 0, healthy: 0 });
}
