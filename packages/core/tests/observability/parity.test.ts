import { describe, expect, it } from "vitest";
import { compareParityJobs, createObservabilityParityHarness } from "../../src/observability/parity.ts";
import type { LogEntry } from "../../src/runtime/logs.ts";
import type { SpecialistJob } from "../../src/observability/types.ts";

function job(overrides: Partial<SpecialistJob> & Pick<SpecialistJob, "beadId" | "repoSlug" | "status" | "updatedAt">): SpecialistJob {
  return {
    jobId: overrides.jobId ?? `${overrides.repoSlug}:${overrides.beadId}`,
    repoSlug: overrides.repoSlug,
    beadId: overrides.beadId,
    chainId: overrides.chainId ?? null,
    epicId: overrides.epicId ?? null,
    chainKind: overrides.chainKind ?? null,
    status: overrides.status,
    updatedAt: overrides.updatedAt,
    specialist: overrides.specialist ?? null,
    lastOutput: overrides.lastOutput ?? null,
    turns: overrides.turns ?? null,
    tools: overrides.tools ?? null,
    model: overrides.model ?? null,
  };
}

describe("observability parity", () => {
  it("reports missing, extra, field, and ordering differences", () => {
    const base = job({ repoSlug: "repo", beadId: "bead", status: "done", updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(compareParityJobs("jobsByBead", "bead", [base], [])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "missing_row" })]));
    expect(compareParityJobs("jobsByBead", "bead", [], [base])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "extra_row" })]));
    expect(compareParityJobs("jobsByBead", "bead", [base], [{ ...base, lastOutput: "changed" }])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "field_delta", path: expect.stringMatching(/\.lastOutput$/) })]));
    const later = { ...base, jobId: "later", beadId: "later" };
    expect(compareParityJobs("recentJobs", "100", [base, later], [later, base], true)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "ordering" })]));
  });

  it("keeps raw specialist output out of persistent parity logs", async () => {
    const secret = "terminal-secret-token";
    const live = job({ repoSlug: "repo", beadId: "bead", status: "done", updatedAt: "2026-01-01T00:00:00.000Z", lastOutput: secret });
    const shadow = { ...live, lastOutput: "different result" };
    const logs: LogEntry[] = [];
    const liveDao = { inFlightJobs: () => [], recentJobs: () => [live], jobsByBead: () => [live] };
    const shadowDao = { inFlightJobs: () => [], recentJobs: () => [shadow], jobsByBead: () => [shadow] };
    const harness = createObservabilityParityHarness(null, { liveDao, shadowDao, emitLog: (entry) => logs.push(entry) });

    const summary = await harness.runOnce();

    expect(summary.diffs.some((diff) => diff.live === secret)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain("different result");
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ path: expect.stringMatching(/lastOutput$/) }) }),
    ]));
  });
});
