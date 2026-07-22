import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../../../packages/core/src/github/database.ts";
import { getRepos } from "../../../../packages/core/src/github/index.ts";
import {
  discoverViaGhCli,
  discoverViaApi,
  filterRepos,
  discoverAndInsert,
  type DiscoveredRepo,
} from "../../src/core/github-discover.ts";

const sampleRepos: DiscoveredRepo[] = [
  { full_name: "alice/recent-public", is_private: false, pushed_at: new Date().toISOString() },
  { full_name: "alice/recent-private", is_private: true, pushed_at: new Date().toISOString() },
  {
    full_name: "alice/old-repo",
    is_private: false,
    pushed_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
  },
  { full_name: "alice/null-pushed", is_private: false, pushed_at: null },
];

function fakeSpawnSync(result: {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  success: boolean;
}) {
  return (() => result) as unknown as typeof Bun.spawnSync;
}

describe("discoverViaGhCli", () => {
  it("parses JSON output from gh repo list", () => {
    const repos = discoverViaGhCli(
      fakeSpawnSync({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify([
          { nameWithOwner: "alice/repo-a", isPrivate: false, pushedAt: "2026-03-01T00:00:00Z" },
          { nameWithOwner: "alice/repo-b", isPrivate: true, pushedAt: "2026-02-01T00:00:00Z" },
          { nameWithOwner: "alice/repo-c", isPrivate: false, pushedAt: null },
        ])),
        stderr: Buffer.from(""),
        success: true,
      }),
    );

    expect(repos).toHaveLength(3);
    expect(repos[0]).toEqual({ full_name: "alice/repo-a", is_private: false, pushed_at: "2026-03-01T00:00:00Z" });
    expect(repos[1]).toEqual({ full_name: "alice/repo-b", is_private: true, pushed_at: "2026-02-01T00:00:00Z" });
    expect(repos[2]).toEqual({ full_name: "alice/repo-c", is_private: false, pushed_at: null });
  });

  it("throws when gh exits with non-zero code", () => {
    expect(() =>
      discoverViaGhCli(
        fakeSpawnSync({
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not logged in"),
          success: false,
        }),
      ),
    ).toThrow("gh repo list failed");
  });
});

describe("discoverViaApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches and paginates repos from REST API", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      full_name: `alice/repo-${i}`,
      private: i % 2 === 0,
      pushed_at: "2026-03-01T00:00:00Z",
    }));
    const page2 = [{ full_name: "alice/repo-100", private: false, pushed_at: "2026-02-01T00:00:00Z" }];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const repos = await discoverViaApi("test-token");
    expect(repos).toHaveLength(101);
    expect(repos[0].full_name).toBe("alice/repo-0");
    expect(repos[0].is_private).toBe(true);
    fetchMock.mockRestore();
  });

  it("throws on non-ok API response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    await expect(discoverViaApi("bad-token")).rejects.toThrow("GitHub API error 401");
    fetchMock.mockRestore();
  });
});

describe("filterRepos", () => {
  it("filters out old repos by default maxAgeDays=180", () => {
    const result = filterRepos(sampleRepos);
    const names = result.map((r) => r.full_name);
    expect(names).toContain("alice/recent-public");
    expect(names).toContain("alice/recent-private");
    expect(names).not.toContain("alice/old-repo");
    expect(names).not.toContain("alice/null-pushed");
  });

  it("excludes private repos when includePrivate=false", () => {
    const result = filterRepos(sampleRepos, { includePrivate: false });
    const names = result.map((r) => r.full_name);
    expect(names).toContain("alice/recent-public");
    expect(names).not.toContain("alice/recent-private");
  });

  it("uses custom maxAgeDays", () => {
    const result = filterRepos(sampleRepos, { maxAgeDays: 500 });
    const names = result.map((r) => r.full_name);
    expect(names).toContain("alice/old-repo");
    expect(names).not.toContain("alice/null-pushed");
  });

  it("filters out repos with null pushed_at", () => {
    const result = filterRepos(sampleRepos);
    expect(result.find((r) => r.pushed_at === null)).toBeUndefined();
  });
});

describe("discoverAndInsert", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-forge-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("inserts discovered repos into the database", async () => {
    const db = createDatabase(join(tmpDir, "state.db"));

    const result = await discoverAndInsert(
      db,
      undefined,
      fakeSpawnSync({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify([
          { nameWithOwner: "alice/repo-a", isPrivate: false, pushedAt: new Date().toISOString() },
          { nameWithOwner: "alice/repo-b", isPrivate: false, pushedAt: new Date().toISOString() },
        ])),
        stderr: Buffer.from(""),
        success: true,
      }),
    );

    expect(result).toHaveLength(2);
    expect(result).toContain("alice/repo-a");
    expect(result).toContain("alice/repo-b");

    const stored = getRepos(db);
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.tracked)).toBe(true);
    expect(stored.find((r) => r.full_name === "alice/repo-a")?.display_name).toBe("repo-a");
    db.close();
  });

  it("falls back to REST API when gh CLI fails", async () => {
    const restoreToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    const db = createDatabase(join(tmpDir, "state.db"));

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { full_name: "alice/api-repo", private: false, pushed_at: new Date().toISOString() },
        ]),
        { status: 200 }
      )
    );

    const result = await discoverAndInsert(
      db,
      undefined,
      fakeSpawnSync({
        exitCode: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("not logged in"),
        success: false,
      }),
    );

    expect(result).toHaveLength(1);
    expect(result).toContain("alice/api-repo");

    const stored = getRepos(db);
    expect(stored).toHaveLength(1);
    fetchMock.mockRestore();
    if (restoreToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = restoreToken;
    db.close();
  });
});
