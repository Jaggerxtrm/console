import { readFileSync } from "node:fs";

export type ThresholdSeverity = "low" | "medium" | "high";

export type Threshold = {
  component: string;
  event: string;
  p95_ms: number;
  severity: ThresholdSeverity;
};

const DEFAULT_THRESHOLDS: readonly Threshold[] = [
  { component: "materializer", event: "run", p95_ms: 2000, severity: "high" },
  { component: "parity", event: "diff", p95_ms: 500, severity: "high" },
  { component: "api", event: "request", p95_ms: 200, severity: "medium" },
  { component: "ws", event: "publish", p95_ms: 50, severity: "medium" },
];

export function loadThresholds(path = process.env.OBSERVABILITY_THRESHOLDS_FILE): readonly Threshold[] {
  if (!path) return DEFAULT_THRESHOLDS;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_THRESHOLDS;
    const values = parsed.filter(isThreshold);
    return values.length > 0 ? values : DEFAULT_THRESHOLDS;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

function isThreshold(value: unknown): value is Threshold {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.component === "string"
    && typeof item.event === "string"
    && typeof item.p95_ms === "number"
    && (item.severity === "low" || item.severity === "medium" || item.severity === "high");
}
