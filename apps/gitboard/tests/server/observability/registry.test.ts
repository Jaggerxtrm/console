import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsCalls = vi.hoisted(() => ({ readdirSync: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      fsCalls.readdirSync += 1;
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

vi.mock("../../../src/server/observability/config.ts", () => ({
  getObservabilityConfig: vi.fn(),
}));

import { getObservabilityConfig } from "../../../src/server/observability/config.ts";

const mockedConfig = getObservabilityConfig as unknown as { mockReturnValue: (value: { roots: string[] }) => void };

async function importRegistry() {
  const registry = await import("../../../src/server/observability/registry.ts");
  registry.__resetObservabilityRegistryForTests();
  return registry;
}

describe("listRepos cache", () => {
  let now = Date.parse("2025-01-01T00:00:00.000Z");

  beforeEach(() => {
    now = Date.parse("2025-01-01T00:00:00.000Z");
    fsCalls.readdirSync = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scans filesystem once across repeated calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-observability-"));
    const repo = join(root, "alpha-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "observability.db"), "a");

    mockedConfig.mockReturnValue({ roots: [root] });

    const { listRepos } = await importRegistry();

    const first = listRepos();
    const second = listRepos();
    const third = listRepos();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(fsCalls.readdirSync).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  it("rescans after refresh window", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-observability-"));
    const repo = join(root, "alpha-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "observability.db"), "a");

    mockedConfig.mockReturnValue({ roots: [root] });

    const { listRepos } = await importRegistry();

    listRepos();
    now += 10_001;
    listRepos();

    expect(fsCalls.readdirSync).toBe(2);

    rmSync(root, { recursive: true, force: true });
  });

  it("discovers modern and legacy specialist database locations", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-observability-"));
    const modern = join(root, "modern-repo", ".specialists", "db");
    const legacy = join(root, "legacy-repo", ".specialists");
    mkdirSync(modern, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(modern, "observability.db"), "modern");
    writeFileSync(join(legacy, "observability.db"), "legacy");

    mockedConfig.mockReturnValue({ roots: [root] });

    const { listRepos } = await importRegistry();
    const repos = listRepos();

    expect(repos.map((repo) => repo.repoSlug).sort()).toEqual(["legacy-repo", "modern-repo"]);
    expect(repos.find((repo) => repo.repoSlug === "modern-repo")?.dbPath).toBe(join(modern, "observability.db"));
    expect(repos.find((repo) => repo.repoSlug === "legacy-repo")?.dbPath).toBe(join(legacy, "observability.db"));

    rmSync(root, { recursive: true, force: true });
  });

  it("discovers repos added after the refresh window", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-observability-"));
    const first = join(root, "first-repo", ".specialists", "db");
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, "observability.db"), "first");

    mockedConfig.mockReturnValue({ roots: [root] });

    const { listRepos } = await importRegistry();
    expect(listRepos().map((repo) => repo.repoSlug)).toEqual(["first-repo"]);

    const second = join(root, "second-repo", ".specialists", "db");
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "observability.db"), "second");
    expect(listRepos().map((repo) => repo.repoSlug)).toEqual(["first-repo"]);

    now += 10_001;
    expect(listRepos().map((repo) => repo.repoSlug).sort()).toEqual(["first-repo", "second-repo"]);

    rmSync(root, { recursive: true, force: true });
  });
});
