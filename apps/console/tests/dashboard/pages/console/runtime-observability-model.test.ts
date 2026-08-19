import { describe, expect, it } from "vitest";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";
import { buildRuntimeObservabilityModel } from "../../../../src/dashboard/pages/console/runtime-observability/model.ts";
import type { RuntimeOverviewResponse } from "../../../../src/types/runtime-observability.ts";

describe("buildRuntimeObservabilityModel", () => {
  it("uses xtmux parent_pane_id for dispatch hierarchy and correlates Specialists by exact bead", () => {
    const model = buildRuntimeObservabilityModel(overview(), [chain("forge-child", "executor", "running")]);
    const child = model.entities.find((entity) => entity.id === "pane:%2");

    expect(model.relations).toContainEqual({
      id: "dispatch:pane:%1:%2",
      source: "pane:%1",
      target: "pane:%2",
      kind: "dispatch",
    });
    expect(child?.specialistJob?.beadId).toBe("forge-child");
    expect(child?.specialistJob?.status).toBe("running");
    expect(model.unboundSpecialists).toHaveLength(0);
    expect(model.timeline.map((event) => event.source)).toContain("xtmux");
    expect(model.timeline.map((event) => event.source)).toContain("specialists");
  });

  it("does not guess a workflow binding when one bead has multiple Specialist roles and xtmux has no matching role", () => {
    const value = overview();
    value.topology!.sessions[0]!.windows[0]!.panes[1]!.agent!.role = "unknown-role";
    const model = buildRuntimeObservabilityModel(value, [
      chain("forge-child", "executor", "running"),
      chain("forge-child", "reviewer", "waiting", "chain-b"),
    ]);
    const child = model.entities.find((entity) => entity.id === "pane:%2");

    expect(child?.specialistJob).toBeNull();
    expect(model.unboundSpecialists).toHaveLength(2);
  });
});

function overview(): RuntimeOverviewResponse {
  return {
    schema_version: "xtrm.console.runtime-observability.v1",
    generated_at_ms: 10_000,
    topology: {
      schema_version: "xtrm.xtmux.topology.v1",
      generated_at_ms: 9_900,
      host: { host_id: "host-a" },
      sessions: [{
        session_id: "$1",
        name: "coordinator",
        created_at_ms: 1,
        activity_at_ms: 9_900,
        attached: true,
        active: true,
        windows: [{
          window_id: "@1",
          window_index: 0,
          name: "main",
          active: true,
          panes: [
            {
              pane_id: "%1",
              pane_index: 0,
              active: true,
              width: 120,
              height: 40,
              left: 0,
              top: 0,
              pid: 100,
              current_command: "claude",
              current_path: "/repo",
              agent: { instance_id: "inst-1", state: "running", role: "coordinator", runtime: "claude" },
            },
            {
              pane_id: "%2",
              pane_index: 1,
              active: false,
              width: 120,
              height: 40,
              left: 120,
              top: 0,
              pid: 101,
              current_command: "pi",
              current_path: "/repo/.worktrees/forge-child",
              agent: {
                instance_id: "inst-2",
                state: "running",
                role: "executor",
                runtime: "pi",
                bead_id: "forge-child",
                parent_pane_id: "%1",
                parent_session_id: "$1",
              },
            },
          ],
        }],
      }],
    },
    events: [{
      createdAtMs: 9_800,
      type: "agent.state",
      domain: "agents",
      eventKey: "agent.state:1",
      sessionId: "$1",
      paneId: "%2",
      instanceId: "inst-2",
      beadId: "forge-child",
      correlationId: null,
      state: "running",
    }],
    source_health: {
      topology: { status: "ok", latency_ms: 4 },
      journal: { status: "ok", latency_ms: 2 },
    },
  };
}

function chain(beadId: string, role: string, status: string, chainId = "chain-a"): ChainSummary {
  const updatedAt = "2026-08-19T01:00:00.000Z";
  return {
    chainId,
    rootBeadId: beadId,
    title: chainId,
    jobs: [{
      repoSlug: "repo-a",
      beadId,
      jobId: `${chainId}-${role}`,
      chainId,
      epicId: null,
      chainKind: role,
      specialist: role,
      status,
      updatedAt,
      lastOutput: "working on the assigned change",
      turns: 2,
      tools: 3,
      model: "test-model",
    }],
    status: status === "waiting" ? "waiting" : "running",
    roles: [{ role, status }],
    elapsedMs: 0,
    lastMessage: "working on the assigned change",
    lastUpdatedAt: updatedAt,
  };
}
