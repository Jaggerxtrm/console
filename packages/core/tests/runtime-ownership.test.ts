import { describe, expect, it } from "vitest";
import { createGitboardFinalRuntimeMigrationPlan, createGitboardRuntimeOwnershipMap, evaluateGitboardDeprecationReadiness, getReadyRuntimeMigrationSurfaceIds } from "../src/runtime/index.ts";

describe("gitboard runtime ownership map", () => {
  it("keeps apps/console out of runtime ownership", () => {
    const ownership = createGitboardRuntimeOwnershipMap();
    const owners = [ownership.appShellTarget, ...ownership.surfaces].map((surface) => surface.currentOwner);

    expect(owners).not.toContain("apps/console");
  });

  it("classifies the high-risk app runtime surfaces before extraction", () => {
    const ownership = createGitboardRuntimeOwnershipMap();
    const surfacesById = new Map(ownership.surfaces.map((surface) => [surface.id, surface]));

    expect(surfacesById.get("xtrm-state-schema")?.knownHighRiskSymbols).toContain("createXtrmDatabase");
    expect(surfacesById.get("runtime-host")?.knownHighRiskSymbols).toContain("createApp");
    expect(surfacesById.get("materializer-runtime")?.knownHighRiskSymbols).toContain("Materializer");
    expect(surfacesById.get("source-lifecycle")?.knownHighRiskSymbols[0]).toBe("ProjectScanner");
    expect(surfacesById.get("terminal-shell-boundary")?.knownHighRiskSymbols).toContain("TerminalBridge");
    expect(surfacesById.get("github-adapter")?.preserves).toContain("durable GitHub tables");
  });

  it("exposes the safe ready front for sequential migration", () => {
    expect(getReadyRuntimeMigrationSurfaceIds()).toEqual(["xtrm-state-schema", "runtime-host"]);
    expect(getReadyRuntimeMigrationSurfaceIds(["xtrm-state-schema", "runtime-host"])).toEqual([
      "materializer-runtime",
      "console-read-models",
      "source-lifecycle",
      "github-adapter",
    ]);
    expect(getReadyRuntimeMigrationSurfaceIds([
      "xtrm-state-schema",
      "runtime-host",
      "materializer-runtime",
    ])).toContain("realtime-log-delivery");
  });

  it("blocks gitboard deprecation until every core-owned surface has moved", () => {
    const ownership = createGitboardRuntimeOwnershipMap();
    const partial = evaluateGitboardDeprecationReadiness(["xtrm-state-schema", "runtime-host"]);

    expect(partial.ready).toBe(false);
    expect(partial.missingSurfaceIds).toContain("materializer-runtime");
    expect(partial.appShellTarget.id).toBe("gitboard-compatibility-shell");

    const complete = evaluateGitboardDeprecationReadiness(ownership.surfaces.map((surface) => surface.id));
    expect(complete.ready).toBe(true);
    expect(complete.missingSurfaceIds).toEqual([]);
  });

  it("defines the final migration children, smoke gates, and wrapper retirement checks", () => {
    const plan = createGitboardFinalRuntimeMigrationPlan();

    expect(plan.epicId).toBe("forge-3dm4");
    expect(plan.targetRuntimeOwner).toBe("@xtrm/core/runtime");
    expect(plan.compatibilityHost).toBe("apps/gitboard");
    expect(plan.children.map((child) => child.key)).toEqual([
      "final-boundary-docs",
      "core-read-model-services",
      "source-lifecycle-extraction",
      "github-runtime-adapter",
      "runtime-host-socket-boundary",
      "terminal-shell-safety",
      "service-static-retirement",
      "final-wrapper-cleanup",
    ]);
    expect(plan.children.find((child) => child.key === "source-lifecycle-extraction")?.gitnexusImpactTargets[0]).toBe("ProjectScanner");
    expect(plan.smokeGates.map((gate) => gate.name)).toContain("GitHub poller enabled smoke");
    expect(plan.wrapperRetirementChecklist).toContain("Console does not open SQLite and remains UI/read-query only.");
  });
});
