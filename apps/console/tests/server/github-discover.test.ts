import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { getRepos } from "../../../../packages/core/src/github/index.ts";
import { discoverAndInsert, filterRepos } from "../../src/server/github/discover.ts";

describe("Console GitHub discovery ownership", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("filters and persists discovered repositories", async () => {
    root = mkdtempSync(join(tmpdir(), "console-github-discover-"));
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const now = new Date().toISOString();
    const result = await discoverAndInsert(db, undefined, (() => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify([
        { nameWithOwner: "alice/recent", isPrivate: false, pushedAt: now },
        { nameWithOwner: "alice/never", isPrivate: false, pushedAt: null },
      ])),
      stderr: Buffer.from(""),
      success: true,
    })) as unknown as typeof Bun.spawnSync);

    expect(result).toEqual(["alice/recent"]);
    expect(getRepos(db)).toMatchObject([{ full_name: "alice/recent", tracked: 1 }]);
    db.close();
  });

  it("retains the private-repository filter contract", () => {
    const recent = new Date().toISOString();
    expect(filterRepos([
      { full_name: "public/repo", is_private: false, pushed_at: recent },
      { full_name: "private/repo", is_private: true, pushed_at: recent },
    ], { includePrivate: false }).map((repo) => repo.full_name)).toEqual(["public/repo"]);
  });
});
