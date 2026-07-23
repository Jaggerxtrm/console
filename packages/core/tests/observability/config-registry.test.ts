import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROOTS, getObservabilityConfig } from "../../src/observability/config.ts";
import { __resetObservabilityRegistryForTests, listRepos } from "../../src/observability/registry.ts";

describe("observability registry", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.OBSERVABILITY_ROOTS;
    vi.restoreAllMocks();
    __resetObservabilityRegistryForTests();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("uses the documented default roots", () => {
    expect(DEFAULT_ROOTS).toEqual(["~/dev/*", "~/projects/*"]);
    expect(getObservabilityConfig().roots).toEqual(expect.any(Array));
  });

  it("caches discovery until the refresh window expires", () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-registry-"));
    roots.push(root);
    const repo = join(root, "alpha-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "observability.db"), "seed");
    process.env.OBSERVABILITY_ROOTS = root;
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00.000Z"));

    const first = listRepos();
    mkdirSync(join(root, "beta-repo"), { recursive: true });
    writeFileSync(join(root, "beta-repo", "observability.db"), "seed");
    expect(listRepos()).toEqual(first);

    now.mockReturnValue(Date.parse("2026-01-01T00:00:10.001Z"));
    expect(listRepos().map((entry) => entry.repoSlug).sort()).toEqual(["alpha-repo", "beta-repo"]);
  });
});
