import { describe, expect, it } from "vitest";
import type { SpecialistJob } from "../../../src/server/observability/types.ts";
import { compareParityJobs } from "../../../src/server/observability/parity.ts";

function job(overrides: Partial<SpecialistJob> & Pick<SpecialistJob, "beadId" | "repoSlug" | "status" | "updatedAt">): SpecialistJob {
  return {
    jobId: overrides.jobId ?? `${overrides.repoSlug}:${overrides.beadId}:${overrides.status}:${overrides.updatedAt}`,
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

describe("compareParityJobs", () => {
  it("flags missing rows", () => {
    const diffs = compareParityJobs("jobsByBead", "bead-1", [job({ repoSlug: "repo", beadId: "bead-1", status: "done", updatedAt: "2026-05-24T00:00:00.000Z" })], []);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: "missing_row", check: "jobsByBead", scope: "bead-1" });
  });

  it("flags extra rows", () => {
    const diffs = compareParityJobs("inFlightJobs", "all", [], [job({ repoSlug: "repo", beadId: "bead-2", status: "running", updatedAt: "2026-05-24T00:00:00.000Z" })]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: "extra_row", check: "inFlightJobs", scope: "all" });
  });

  it("flags field deltas", () => {
    const diffs = compareParityJobs(
      "jobsByBead",
      "bead-3",
      [job({ repoSlug: "repo", beadId: "bead-3", status: "done", updatedAt: "2026-05-24T00:00:00.000Z", lastOutput: "a" })],
      [job({ repoSlug: "repo", beadId: "bead-3", status: "done", updatedAt: "2026-05-24T00:00:00.000Z", lastOutput: "b" })],
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ kind: "field_delta", check: "jobsByBead", scope: "bead-3" });
    expect(diffs[0].live).toBe("a");
    expect(diffs[0].shadow).toBe("b");
  });

  it("flags ordering", () => {
    const live = [
      job({ repoSlug: "repo", beadId: "bead-4", status: "done", updatedAt: "2026-05-24T00:00:02.000Z" }),
      job({ repoSlug: "repo", beadId: "bead-5", status: "done", updatedAt: "2026-05-24T00:00:01.000Z" }),
    ];
    const shadow = [...live].reverse();
    const diffs = compareParityJobs("recentJobs", "100", live, shadow, true);
    expect(diffs.some((diff) => diff.kind === "ordering")).toBe(true);
  });
});
