import { describe, expect, it } from "vitest";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";
import { buildRuntimeObservabilityModel } from "../../../../src/dashboard/pages/console/runtime-observability/model.ts";
import type { RuntimeOverviewResponse } from "../../../../src/types/runtime-observability.ts";

describe("buildRuntimeObservabilityModel", () => {
  it("uses xtmux parent_pane_id and exact bead correlation", () => {
    const model = buildRuntimeObservabilityModel(overview("executor"), [chain("executor", "chain-a")]);
    const child = model.entities.find((entity) => entity.id === "pane:%2");
    expect(model.relations).toContainEqual({ id: "dispatch:pane:%1:%2", source: "pane:%1", target: "pane:%2", kind: "dispatch" });
    expect(child?.specialistJob?.beadId).toBe("forge-child");
    expect(model.unboundSpecialists).toHaveLength(0);
  });

  it("does not guess when several Specialist jobs share a bead and role is ambiguous", () => {
    const model = buildRuntimeObservabilityModel(overview("unknown-role"), [chain("executor", "chain-a"), chain("reviewer", "chain-b")]);
    const child = model.entities.find((entity) => entity.id === "pane:%2");
    expect(child?.specialistJob).toBeNull();
    expect(model.unboundSpecialists).toHaveLength(2);
  });
});

function overview(role: string): RuntimeOverviewResponse {
  return {
    schema_version: "xtrm.console.runtime-observability.v1",
    generated_at_ms: 10_000,
    topology: { sessions: [{
      session_id: "$1", name: "coordinator", created_at_ms: 1, activity_at_ms: 9_900, attached: true, active: true,
      windows: [{ window_id: "@1", window_index: 0, name: "main", active: true, panes: [
        { pane_id: "%1", pane_index: 0, active: true, width: 120, height: 40, left: 0, top: 0, pid: 100, current_command: "claude", current_path: "/repo", agent: { instance_id: "inst-1", state: "running", role: "coordinator", runtime: "claude" } },
        { pane_id: "%2", pane_index: 1, active: false, width: 120, height: 40, left: 120, top: 0, pid: 101, current_command: "pi", current_path: "/repo/.worktrees/forge-child", agent: { instance_id: "inst-2", state: "running", role, runtime: "pi", bead_id: "forge-child", parent_pane_id: "%1", parent_session_id: "$1" } },
      ] }],
    }] },
    events: [],
    source_health: { topology: { status: "ok", latency_ms: 4 }, journal: { status: "ok", latency_ms: 2 } },
  };
}

function chain(role: string, chainId: string): ChainSummary {
  const updatedAt = "2026-08-19T01:00:00.000Z";
  return {
    chainId, rootBeadId: "forge-child", title: chainId,
    jobs: [{ repoSlug: "repo-a", beadId: "forge-child", jobId: `${chainId}-${role}`, chainId, epicId: null, chainKind: role, specialist: role, status: "running", updatedAt, lastOutput: null, turns: 1, tools: 1, model: "test" }],
    status: "running", roles: [{ role, status: "running" }], elapsedMs: 0, lastMessage: "", lastUpdatedAt: updatedAt,
  };
}
