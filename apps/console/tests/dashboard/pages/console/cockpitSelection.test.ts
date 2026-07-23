import { describe, expect, it } from "vitest";
import { buildBeadActivitySwappedTelemetry, buildChainSelectedTelemetry, buildFirstPaintTelemetry, buildListRenderedTelemetry, deriveSelection, toggleFilter } from "../../../../src/dashboard/pages/console/specialists/cockpitSelection.ts";
import type { ChainSummary } from "../../../../src/dashboard/hooks/useChains.ts";

const chains = [
  chain({ chainId: "chain-1", rootBeadId: "bead-1", status: "running" }),
  chain({ chainId: "chain-2", rootBeadId: "bead-2", status: "done" }),
] satisfies ChainSummary[];

describe("cockpitSelection", () => {
  it("returns no selection for empty chains", () => {
    const selection = deriveSelection([], new Set(["all"]), null);

    expect(selection.visibleChains).toEqual([]);
    expect(selection.selectedChainId).toBeNull();
    expect(selection.selectedChain).toBeNull();
  });

  it("shows all visible and auto-selects first chain when filters=all", () => {
    const selection = deriveSelection(chains, new Set(["all"]), null);

    expect(selection.visibleChains).toHaveLength(2);
    expect(selection.selectedChainId).toBe("chain-1");
    expect(selection.selectedChain?.rootBeadId).toBe("bead-1");
  });

  it("keeps explicit selected chain when valid", () => {
    const selection = deriveSelection(chains, new Set(["all"]), "chain-2");

    expect(selection.selectedChainId).toBe("chain-2");
    expect(selection.selectedChain?.rootBeadId).toBe("bead-2");
  });

  it("falls back to first visible chain when selected id is invalid", () => {
    const selection = deriveSelection(chains, new Set(["all"]), "missing");

    expect(selection.selectedChainId).toBe("chain-1");
    expect(selection.selectedChain?.rootBeadId).toBe("bead-1");
  });

  it("builds cockpit telemetry payloads", () => {
    expect(buildListRenderedTelemetry(chains, { running: 1, done: 1 })).toMatchObject({ rowCount: 2, paletteVersion: "type-palette@1", typesByCount: { running: 1, done: 1 } });
    expect(buildFirstPaintTelemetry(chains)).toMatchObject({ rowCount: 2, paletteVersion: "type-palette@1" });
    expect(buildChainSelectedTelemetry("chain-2")).toEqual({ chainId: "chain-2" });
    expect(buildBeadActivitySwappedTelemetry(chains[1]!)).toEqual({ chainId: "chain-2", beadId: "bead-2" });
  });

  it("keeps filter toggles pure", () => {
    expect(toggleFilter(new Set(["all"]), "running")).toEqual(new Set(["running"]));
    expect(toggleFilter(new Set(["running"]), "running")).toEqual(new Set(["all"]));
  });
});

function chain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    chainId: overrides.chainId ?? "chain",
    rootBeadId: overrides.rootBeadId ?? "bead",
    title: overrides.title ?? "chain",
    jobs: overrides.jobs ?? [],
    status: overrides.status ?? "running",
    roles: overrides.roles ?? [],
    elapsedMs: overrides.elapsedMs ?? 0,
    lastMessage: overrides.lastMessage ?? "",
    lastUpdatedAt: overrides.lastUpdatedAt ?? "2026-05-31T00:00:00.000Z",
  };
}
