import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const allowedMetrics = new Set([
  "xtrm_jobs_total",
  "xtrm_job_duration_seconds",
  "xtrm_job_wait_seconds",
  "xtrm_job_state",
  "xtrm_llm_tokens_total",
  "xtrm_chains_total",
  "xtrm_chain_duration_seconds",
  "xtrm_gate_verdicts_total",
  "xtrm_evidence_refs_total",
]);

const forbiddenLabels = new Set([
  "job_id",
  "bead_id",
  "issue_id",
  "chain_id",
  "participant_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "tool_call_id",
  "path",
  "file_path",
  "command",
  "url",
  "error",
  "raw_error",
  "diff",
  "prompt",
  "user",
  "email",
  "token",
  "credential",
]);

interface MetricFixture {
  name: string;
  labels: string[];
}

function loadFixture(): { metrics: MetricFixture[] } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/operations-prometheus-metrics.json");
  return JSON.parse(readFileSync(path, "utf8")) as { metrics: MetricFixture[] };
}

function validateMetricFixture(metrics: MetricFixture[]): string[] {
  const errors: string[] = [];
  for (const metric of metrics) {
    if (!allowedMetrics.has(metric.name)) errors.push(`${metric.name}: metric is not in the Console Operations allowlist`);
    for (const label of metric.labels) {
      if (forbiddenLabels.has(label)) errors.push(`${metric.name}: forbidden high-cardinality label ${label}`);
      if (/(_id|_path|url|command|error|diff|prompt|email|token|credential)$/i.test(label) && !["evidence_kind"].includes(label)) {
        errors.push(`${metric.name}: suspicious high-cardinality label ${label}`);
      }
    }
  }
  return errors;
}

describe("Console Operations Prometheus cardinality fixtures", () => {
  it("uses only approved xtrm metrics and low-cardinality labels", () => {
    const fixture = loadFixture();
    expect(validateMetricFixture(fixture.metrics)).toEqual([]);
  });

  it("rejects forbidden drilldown identifiers as labels", () => {
    expect(validateMetricFixture([
      { name: "xtrm_jobs_total", labels: ["repo", "job_id", "trace_id", "file_path"] },
    ])).toEqual([
      "xtrm_jobs_total: forbidden high-cardinality label job_id",
      "xtrm_jobs_total: suspicious high-cardinality label job_id",
      "xtrm_jobs_total: forbidden high-cardinality label trace_id",
      "xtrm_jobs_total: suspicious high-cardinality label trace_id",
      "xtrm_jobs_total: forbidden high-cardinality label file_path",
      "xtrm_jobs_total: suspicious high-cardinality label file_path",
    ]);
  });
});
