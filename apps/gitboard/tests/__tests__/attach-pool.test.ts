import { describe, expect, it, vi } from "vitest";
import { createAttachPool } from "../../src/server/observability/attach-pool.js";

const FIXTURES = [
  {
    repoSlug: "repo-a",
    repoPath: "fixtures/repo-a",
    dbPath: new URL("./fixtures/observability/repo-a.db", import.meta.url).pathname,
    mtimeMs: 1,
  },
  {
    repoSlug: "repo-b",
    repoPath: "fixtures/repo-b",
    dbPath: new URL("./fixtures/observability/repo-b.db", import.meta.url).pathname,
    mtimeMs: 1,
  },
  {
    repoSlug: "repo-c",
    repoPath: "fixtures/repo-c",
    dbPath: new URL("./fixtures/observability/repo-c.db", import.meta.url).pathname,
    mtimeMs: 1,
  },
] as const;

describe("createAttachPool", () => {
  it("attaches only compatible dbs", () => {
    const warn = vi.fn();
    const pool = createAttachPool(FIXTURES, { logger: { warn } });

    const attached = pool.withAttached((db) => {
      return db
        .prepare("PRAGMA database_list")
        .all()
        .filter((row: { name?: string }) => row.name?.startsWith("repo_"));
    });

    expect(attached).toHaveLength(2);
    expect(attached.map((row: { name?: string }) => row.name)).toEqual([
      expect.stringContaining("repo_repo-a_"),
      expect.stringContaining("repo_repo-b_"),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("schema_version");
    expect(String(warn.mock.calls[0]?.[0])).toContain("repo-c");
  });

  it("evicts least-recently used attachment when pool size exceeded", () => {
    const pool = createAttachPool(FIXTURES, { maxAttached: 1, logger: { warn: vi.fn() } });

    const attached = pool.withAttached((db) => {
      return db
        .prepare("PRAGMA database_list")
        .all()
        .filter((row: { name?: string }) => row.name?.startsWith("repo_"))
        .map((row: { name?: string }) => row.name);
    });

    expect(attached).toHaveLength(1);
    expect(attached[0]).toEqual(expect.stringContaining("repo_repo-b_"));
    expect(attached[0]).not.toEqual(expect.stringContaining("repo_repo-a_"));
  });
});
