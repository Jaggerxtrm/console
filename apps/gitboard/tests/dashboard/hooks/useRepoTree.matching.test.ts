import { describe, expect, it } from "vitest";
import { findBeadsSide, normalizeProjectKey } from "../../../src/dashboard/hooks/useRepoTree.ts";
import type { BeadsProject } from "../../../src/types/beads.ts";

const project = (name: string): BeadsProject => ({
  id: `${name}-id`,
  name,
  path: `/tmp/${name}`,
  beadsPath: `/tmp/${name}/.beads`,
  issueCount: 0,
  lastScanned: "2026-01-01T00:00:00.000Z",
  status: "active",
});

const source = { label: "dolt" as const, title: "Dolt connected", healthy: true };

describe("useRepoTree beads matching", () => {
  it("normalizes separators and case", () => {
    expect(normalizeProjectKey("Darth_Feedor.Master")).toBe("darth-feedor-master");
  });

  it("matches GitHub repo tails with organization prefixes to beads project names", () => {
    const market = { project: project("market-data"), stats: null, source };
    const map = new Map([[market.project.name, market]]);

    expect(findBeadsSide("mercury-market-data", map)?.project.name).toBe("market-data");
  });

  it("matches normalized separator aliases", () => {
    const darth = { project: project("darth-feedor"), stats: null, source };
    const map = new Map([[darth.project.name, darth]]);

    expect(findBeadsSide("darth_feedor", map)?.project.name).toBe("darth-feedor");
  });

  it("prefers exact project name matches", () => {
    const exact = { project: project("mercury-market-data"), stats: null, source };
    const suffix = { project: project("market-data"), stats: null, source };
    const map = new Map([[exact.project.name, exact], [suffix.project.name, suffix]]);

    expect(findBeadsSide("mercury-market-data", map)?.project.name).toBe("mercury-market-data");
  });
});
