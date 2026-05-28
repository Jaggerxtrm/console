import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, rmSync, renameSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/core/store.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";
import { foldGitboardSQLite } from "../../src/core/migrations/fold-gitboard-sqlite.ts";

describe("foldGitboardSQLite", () => {
  let dir: string;
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitboard-fold-test-"));
    sourcePath = join(dir, "gitboard.sqlite");
    targetPath = join(dir, "xtrm.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops on fresh install", () => {
    const targetDb = createXtrmDatabase(targetPath);
    foldGitboardSQLite(sourcePath, targetDb);
    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(targetPath)).toBe(true);
    targetDb.close();
  });

  it("no-ops on pre-migrated install", () => {
    const targetDb = createXtrmDatabase(targetPath);
    const migratedSource = `${sourcePath}.migrated.123`;
    const sourceDb = createDatabase(sourcePath);
    sourceDb.close();
    renameSync(sourcePath, migratedSource);

    foldGitboardSQLite(sourcePath, targetDb);

    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(migratedSource)).toBe(true);
    targetDb.close();
  });

  it("copies rows, verifies counts, and renames active source", () => {
    const sourceDb = createDatabase(sourcePath);
    const targetDb = createXtrmDatabase(targetPath);

    seedGithubRows(sourceDb);
    foldGitboardSQLite(sourcePath, targetDb);

    expect(existsSync(sourcePath)).toBe(false);
    const migrated = readdirSync(dir).find((name) => name.startsWith("gitboard.sqlite.migrated."));
    expect(migrated).toBeDefined();
    expect(existsSync(join(dir, migrated!))).toBe(true);

    expect(count(targetDb, "github_events")).toBe(1);
    expect(count(targetDb, "github_commits")).toBe(1);
    expect(count(targetDb, "github_repos")).toBe(1);
    expect(count(targetDb, "github_prs")).toBe(1);
    expect(count(targetDb, "github_issues")).toBe(1);
    expect(count(targetDb, "github_releases")).toBe(1);
    expect(count(targetDb, "github_repo_poll_state")).toBe(1);

    sourceDb.close();
    targetDb.close();
  });
});

function seedGithubRows(db: ReturnType<typeof createDatabase>): void {
  db.exec(`
    INSERT INTO github_events (id, type, repo, actor, created_at) VALUES ('e1', 'PushEvent', 'repo/a', 'alice', CURRENT_TIMESTAMP);
    INSERT INTO github_commits (sha, repo, author, message, event_id, committed_at) VALUES ('c1', 'repo/a', 'alice', 'msg', 'e1', CURRENT_TIMESTAMP);
    INSERT INTO github_repos (full_name, display_name, tracked) VALUES ('repo/a', 'repo-a', 1);
    INSERT INTO github_prs (repo, number, title, state, author, created_at) VALUES ('repo/a', 1, 'pr', 'open', 'alice', CURRENT_TIMESTAMP);
    INSERT INTO github_issues (repo, number, title, state, author, created_at) VALUES ('repo/a', 1, 'issue', 'open', 'alice', CURRENT_TIMESTAMP);
    INSERT INTO github_releases (repo, tag_name, release_id, author_login, published_at, created_at) VALUES ('repo/a', 'v1.0.0', 'r1', 'alice', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO github_repo_poll_state (repo, last_issue_updated_at, last_pr_updated_at, last_activity_at) VALUES ('repo/a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
}

function count(db: ReturnType<typeof createXtrmDatabase>, table: string): number {
  return db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
}

