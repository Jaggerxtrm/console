import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type ThresholdSeverity = "low" | "medium" | "high";

export type Threshold = {
  component: string;
  event: string;
  p95_ms: number;
  severity: ThresholdSeverity;
};

export type VerificationBreach = {
  component: string;
  event: string;
  threshold: number;
  observed: number;
  severity: ThresholdSeverity;
};

type VerificationBucket = {
  count: number;
  error_count: number;
  durations_ms: number[];
};

type MutableBucket = DurationSampler & {
  count: number;
  error_count: number;
};

type DurationSampler = {
  values: number[];
  seen: number;
  state: number;
};

export type VerificationResult = {
  by_component: Record<string, VerificationBucket>;
  by_event: Record<string, VerificationBucket>;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  breaches: VerificationBreach[];
};

export type VerifierMetrics = {
  duration_ms: number;
  files_seen: number;
  files_opened: number;
  files_pruned: number;
  lines_scanned: number;
  malformed_lines: number;
  file_errors: number;
  error_count: number;
};

export type VerifierOptions = {
  readonly dir?: string;
  readonly thresholdsPath?: string;
  readonly onMetrics?: (metrics: VerifierMetrics) => void;
};

type SummaryAccumulator = {
  readonly by_component: Record<string, MutableBucket>;
  readonly by_event: Record<string, MutableBucket>;
  readonly allDurations: DurationSampler;
  error_count: number;
};

type MutableMetrics = Omit<VerifierMetrics, "duration_ms">;

const MAX_DURATION_SAMPLES = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLDS: readonly Threshold[] = [
  { component: "materializer", event: "run", p95_ms: 2000, severity: "high" },
  { component: "parity", event: "diff", p95_ms: 500, severity: "high" },
  { component: "api", event: "request", p95_ms: 200, severity: "medium" },
  { component: "ws", event: "publish", p95_ms: 50, severity: "medium" },
];

export class Verifier {
  constructor(private readonly options: VerifierOptions = {}) {}

  async verify(since: Date | string, until: Date | string): Promise<VerificationResult> {
    const startedAt = performance.now();
    const sinceMs = toMs(since);
    const untilMs = toMs(until);
    const metrics: MutableMetrics = {
      files_seen: 0,
      files_opened: 0,
      files_pruned: 0,
      lines_scanned: 0,
      malformed_lines: 0,
      file_errors: 0,
      error_count: 0,
    };
    const accumulator = createAccumulator();

    try {
      await this.readEntries(sinceMs, untilMs, accumulator, metrics);
      metrics.error_count = accumulator.error_count;
      return buildResult(accumulator, loadThresholds(this.options.thresholdsPath));
    } finally {
      reportMetrics(this.options.onMetrics, { ...metrics, duration_ms: Math.round(performance.now() - startedAt) });
    }
  }

  private async readEntries(sinceMs: number, untilMs: number, accumulator: SummaryAccumulator, metrics: MutableMetrics): Promise<void> {
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs) return;
    const dir = this.options.dir ?? process.env.LOG_DIR ?? "/data/logs";
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      metrics.file_errors += 1;
      return;
    }

    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
      metrics.files_seen += 1;
      if (!fileIntersectsInterval(name, sinceMs, untilMs)) {
        metrics.files_pruned += 1;
        continue;
      }
      metrics.files_opened += 1;
      await readLogFile(join(dir, name), sinceMs, untilMs, accumulator, metrics);
    }
  }
}

export function summarize(entries: readonly Record<string, unknown>[], thresholds: readonly Threshold[]): VerificationResult {
  const accumulator = createAccumulator();
  for (const entry of entries) addEntry(accumulator, entry);
  return buildResult(accumulator, thresholds);
}

export function loadThresholds(path = process.env.OBSERVABILITY_THRESHOLDS_FILE): readonly Threshold[] {
  if (!path) return DEFAULT_THRESHOLDS;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return DEFAULT_THRESHOLDS;
    const values = parsed.filter(isThreshold);
    return values.length > 0 ? values : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function createVerifier(options: VerifierOptions = {}): Verifier {
  return new Verifier(options);
}

async function readLogFile(path: string, sinceMs: number, untilMs: number, accumulator: SummaryAccumulator, metrics: MutableMetrics): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      metrics.lines_scanned += 1;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        metrics.malformed_lines += 1;
        continue;
      }
      if (!isRecord(value)) {
        metrics.malformed_lines += 1;
        continue;
      }
      const ts = typeof value.ts === "string" ? Date.parse(value.ts) : Number.NaN;
      if (Number.isNaN(ts) || ts < sinceMs || ts > untilMs) continue;
      addEntry(accumulator, value);
    }
  } catch {
    metrics.file_errors += 1;
  } finally {
    lines.close();
    input.destroy();
  }
}

function createAccumulator(): SummaryAccumulator {
  return { by_component: {}, by_event: {}, allDurations: createSampler(), error_count: 0 };
}

function addEntry(accumulator: SummaryAccumulator, entry: Record<string, unknown>): void {
  const component = typeof entry.component === "string" ? entry.component : "unknown";
  const event = typeof entry.event === "string" ? entry.event : "unknown";
  const data = isRecord(entry.data) ? entry.data : {};
  const duration = typeof data.duration_ms === "number" ? data.duration_ms : undefined;
  const level = typeof entry.level === "string" ? entry.level : "info";
  const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
  const isError = level === "error" || outcome === "error";

  bump(accumulator.by_component, component, duration, isError);
  bump(accumulator.by_event, `${component}.${event}`, duration, isError);
  if (typeof duration === "number") addSample(accumulator.allDurations, duration);
  if (isError) accumulator.error_count += 1;
}

function buildResult(accumulator: SummaryAccumulator, thresholds: readonly Threshold[]): VerificationResult {
  const breaches = thresholds.flatMap((threshold) => {
    const observed = percentile(accumulator.by_event[`${threshold.component}.${threshold.event}`]?.values ?? [], 95);
    return observed > threshold.p95_ms ? [{ component: threshold.component, event: threshold.event, threshold: threshold.p95_ms, observed, severity: threshold.severity }] : [];
  }).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.component.localeCompare(b.component) || a.event.localeCompare(b.event));

  return {
    by_component: toPublicBuckets(accumulator.by_component),
    by_event: toPublicBuckets(accumulator.by_event),
    error_count: accumulator.error_count,
    p50_ms: percentile(accumulator.allDurations.values, 50),
    p95_ms: percentile(accumulator.allDurations.values, 95),
    p99_ms: percentile(accumulator.allDurations.values, 99),
    breaches,
  };
}

function bump(bucket: Record<string, MutableBucket>, key: string, duration: number | undefined, isError: boolean): void {
  bucket[key] ??= { count: 0, error_count: 0, values: [], seen: 0, state: 0x9e3779b9 };
  bucket[key].count += 1;
  if (isError) bucket[key].error_count += 1;
  if (typeof duration === "number") {
    addSample(bucket[key], duration);
  }
}

function toPublicBuckets(buckets: Record<string, MutableBucket>): Record<string, VerificationBucket> {
  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [key, {
    count: bucket.count,
    error_count: bucket.error_count,
    durations_ms: bucket.values,
  }]));
}

function createSampler(): DurationSampler {
  return { values: [], seen: 0, state: 0x9e3779b9 };
}

function addSample(sampler: DurationSampler, value: number): void {
  const seen = sampler.seen;
  sampler.seen += 1;
  if (sampler.values.length < MAX_DURATION_SAMPLES) {
    sampler.values.push(value);
    return;
  }
  sampler.state = (Math.imul(1664525, sampler.state) + 1013904223) >>> 0;
  const candidate = Math.floor((sampler.state / 0x1_0000_0000) * sampler.seen);
  if (candidate < MAX_DURATION_SAMPLES) sampler.values[candidate] = value;
}

function reportMetrics(callback: ((metrics: VerifierMetrics) => void) | undefined, metrics: VerifierMetrics): void {
  if (!callback) return;
  try {
    callback(metrics);
  } catch (error) {
    // Telemetry is observer-only; sink failures must not alter verification outcome.
    void error;
  }
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function severityRank(severity: ThresholdSeverity): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileIntersectsInterval(name: string, sinceMs: number, untilMs: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
  if (!match) return false;
  const dayStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(dayStart) || new Date(dayStart).toISOString().slice(0, 10) !== name.slice(0, 10)) return false;
  return dayStart <= untilMs && dayStart + DAY_MS - 1 >= sinceMs;
}

function isThreshold(value: unknown): value is Threshold {
  if (!isRecord(value)) return false;
  return typeof value.component === "string"
    && typeof value.event === "string"
    && typeof value.p95_ms === "number"
    && (value.severity === "low" || value.severity === "medium" || value.severity === "high");
}
