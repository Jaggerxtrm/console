import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadThresholds, type Threshold } from "./thresholds.ts";

export type VerificationBreach = { component: string; event: string; threshold: number; observed: number; severity: Threshold["severity"] };
export type VerificationResult = {
  by_component: Record<string, { count: number; error_count: number; durations_ms: number[] }>;
  by_event: Record<string, { count: number; error_count: number; durations_ms: number[] }>;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  breaches: VerificationBreach[];
};

export class Verifier {
  constructor(private readonly options: { dir?: string; thresholdsPath?: string } = {}) {}

  verify(since: Date | string, until: Date | string): VerificationResult {
    const sinceMs = toMs(since);
    const untilMs = toMs(until);
    const thresholds = loadThresholds(this.options.thresholdsPath);
    const entries = this.readEntries(sinceMs, untilMs);
    return summarize(entries, thresholds);
  }

  private readEntries(sinceMs: number, untilMs: number): Array<Record<string, unknown>> {
    const dir = this.options.dir ?? process.env.LOG_DIR ?? "/data/logs";
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    const lines: Array<Record<string, unknown>> = [];
    for (const file of files) {
      try {
        for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
          if (!line) continue;
          const entry = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
          if (Number.isNaN(ts) || ts < sinceMs || ts > untilMs) continue;
          lines.push(entry);
        }
      } catch {}
    }
    return lines;
  }
}

export function summarize(entries: readonly Record<string, unknown>[], thresholds: readonly Threshold[]): VerificationResult {
  const by_component: VerificationResult["by_component"] = {};
  const by_event: VerificationResult["by_event"] = {};
  const allDurations: number[] = [];
  let error_count = 0;

  for (const entry of entries) {
    const component = typeof entry.component === "string" ? entry.component : "unknown";
    const event = typeof entry.event === "string" ? entry.event : "unknown";
    const data = typeof entry.data === "object" && entry.data ? entry.data as Record<string, unknown> : {};
    const duration = typeof data.duration_ms === "number" ? data.duration_ms : undefined;
    const level = typeof entry.level === "string" ? entry.level : "info";
    const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
    const isError = level === "error" || outcome === "error";

    bump(by_component, component, duration, isError);
    bump(by_event, `${component}.${event}`, duration, isError);
    if (typeof duration === "number") allDurations.push(duration);
    if (isError) error_count += 1;
  }

  const breaches = thresholds.flatMap((threshold) => {
    const observed = percentile(by_event[`${threshold.component}.${threshold.event}`]?.durations_ms ?? [], 95);
    return observed > threshold.p95_ms ? [{ component: threshold.component, event: threshold.event, threshold: threshold.p95_ms, observed, severity: threshold.severity }] : [];
  }).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.component.localeCompare(b.component) || a.event.localeCompare(b.event));

  return {
    by_component,
    by_event,
    error_count,
    p50_ms: percentile(allDurations, 50),
    p95_ms: percentile(allDurations, 95),
    p99_ms: percentile(allDurations, 99),
    breaches,
  };
}

function bump(bucket: Record<string, { count: number; error_count: number; durations_ms: number[] }>, key: string, duration: number | undefined, isError: boolean): void {
  bucket[key] ??= { count: 0, error_count: 0, durations_ms: [] };
  bucket[key].count += 1;
  if (isError) bucket[key].error_count += 1;
  if (typeof duration === "number") bucket[key].durations_ms.push(duration);
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function severityRank(severity: Threshold["severity"]): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function createVerifier(options: { dir?: string; thresholdsPath?: string } = {}): Verifier {
  return new Verifier(options);
}
