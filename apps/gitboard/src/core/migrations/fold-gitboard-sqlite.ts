import { existsSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";
import { emit, makeLogEntry } from "../logger.ts";

const TABLES = [
  "github_events",
  "github_commits",
  "github_repos",
  "github_prs",
  "github_issues",
  "github_releases",
  "github_repo_poll_state",
] as const;

type TableName = (typeof TABLES)[number];
type CountMap = Record<TableName, number>;

export function foldGitboardSQLite(sourcePath: string, targetDb: Database): void {
  const migratedPath = `${sourcePath}.migrated.${Date.now()}`;
  if (!existsSync(sourcePath)) {
    if (existsSync(migratedPath)) {
      emit(makeLogEntry("migration", "fold-github.skip", "info", undefined, { source_path: sourcePath, migrated_path: migratedPath, reason: "already_migrated" }));
    }
    return;
  }

  const sourceDb = new Database(sourcePath, { readonly: true });
  try {
    const sourceCounts = countRows(sourceDb);
    const targetCountsBefore = countRows(targetDb);
    const needsCopy = TABLES.some((table) => sourceCounts[table] !== targetCountsBefore[table]);

    emit(makeLogEntry("migration", "fold-github.start", "info", undefined, { source_path: sourcePath, target_counts: targetCountsBefore, source_counts: sourceCounts }));

    if (needsCopy) {
      attachSource(targetDb, sourcePath);
      try {
        for (const table of TABLES) {
          copyTable(targetDb, table);
          emit(makeLogEntry("migration", "fold-github.copy", "info", undefined, { table, row_count: sourceCounts[table] }));
        }
      } finally {
        detachSource(targetDb);
      }
    } else {
      emit(makeLogEntry("migration", "fold-github.skip", "info", undefined, { source_path: sourcePath, reason: "counts_match" }));
    }

    const targetCountsAfter = countRows(targetDb);
    verifyCounts(sourceCounts, targetCountsAfter);
    emit(makeLogEntry("migration", "fold-github.verify", "info", undefined, { source_counts: sourceCounts, target_counts: targetCountsAfter }));

    renameSync(sourcePath, migratedPath);
    emit(makeLogEntry("migration", "fold-github.complete", "info", undefined, { source_path: sourcePath, migrated_path: migratedPath, row_counts: targetCountsAfter }));
  } finally {
    sourceDb.close();
  }
}

function attachSource(targetDb: Database, sourcePath: string): void {
  targetDb.exec(`ATTACH DATABASE '${sourcePath.replace(/'/g, "''")}' AS source`);
}

function detachSource(targetDb: Database): void {
  targetDb.exec("DETACH DATABASE source");
}

function countRows(db: Database): CountMap {
  return Object.fromEntries(TABLES.map((table) => [table, rowCount(db, table)])) as CountMap;
}

function rowCount(db: Database, table: TableName): number {
  return db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
}

function copyTable(targetDb: Database, table: TableName): void {
  switch (table) {
    case "github_commits":
      targetDb.exec(`INSERT OR REPLACE INTO main.github_commits
        (sha, repo, branch, author, message, message_full, url, additions, deletions, changed_files, event_id, committed_at)
        SELECT sha, repo, branch, author, message, NULL, url, additions, deletions, changed_files, event_id, committed_at
        FROM source.github_commits`);
      return;
    case "github_repo_poll_state":
      targetDb.exec(`INSERT OR REPLACE INTO main.github_repo_poll_state
        (repo, last_issue_updated_at, last_pr_updated_at, last_activity_at, issue_etag, pr_etag, paused_until, last_release_published_at, release_etag)
        SELECT repo, last_issue_updated_at, last_pr_updated_at, last_activity_at, issue_etag, pr_etag, paused_until, NULL, NULL
        FROM source.github_repo_poll_state`);
      return;
    default:
      targetDb.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM source.${table}`);
  }
}

function verifyCounts(sourceCounts: CountMap, targetCounts: CountMap): void {
  for (const table of TABLES) {
    if (sourceCounts[table] !== targetCounts[table]) {
      throw new Error(`Failed to fold ${table}: source=${sourceCounts[table]} target=${targetCounts[table]}`);
    }
  }
}
