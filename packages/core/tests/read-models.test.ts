import { describe, expect, it } from "vitest";
import { createConsoleReadModelContracts, findConsoleReadModelByRoute } from "../src/state/index.ts";

describe("daemon-backed Console read-model contracts", () => {
  it("covers current Console API surfaces", () => {
    const routes = createConsoleReadModelContracts().flatMap((contract) => contract.currentRoutes);
    expect(routes).toContain("/api/substrate/projects/:projectId/issues");
    expect(routes).toContain("/api/specialists/jobs/in-flight");
    expect(routes).toContain("/api/console/graph");
    expect(routes).toContain("/api/feed");
  });

  it("classifies native, derived, legacy bridge, and durable adapter boundaries", () => {
    const contracts = createConsoleReadModelContracts();
    expect(contracts.find((contract) => contract.id === "substrate.issue-graph")?.entities[0]?.source).toBe("native-domain-state");
    expect(contracts.find((contract) => contract.id === "feed.rollups")?.entities[0]?.source).toBe("derived-projection");
    expect(contracts.find((contract) => contract.id === "substrate.issue-graph")?.entities[0]?.legacyTables).toContain("substrate_issues");
  });

  it("maps concrete routes back to contracts", () => {
    expect(findConsoleReadModelByRoute("/api/substrate/projects/gitboard/issues")?.id).toBe("substrate.issue-graph");
    expect(findConsoleReadModelByRoute("/api/specialists/jobs/in-flight")?.id).toBe("specialists.activity-evidence");
    expect(findConsoleReadModelByRoute("/api/feed")?.id).toBe("feed.rollups");
  });
});
