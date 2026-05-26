import { Database } from "bun:sqlite";

export const XTRM_TABLES = [
  "substrate_issues",
  "substrate_dependencies",
  "specialist_jobs",
  "specialist_job_events",
  "substrate_job_link",
  "sources",
  "materialization_state",
] as const;

export type XtrmTableName = (typeof XTRM_TABLES)[number];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS substrate_issues (
  repo_slug      TEXT NOT NULL,
  issue_id       TEXT NOT NULL,
  title          TEXT,
  body           TEXT,
  state          TEXT NOT NULL,
  priority       INTEGER,
  issue_type     TEXT,
  owner          TEXT,
  labels         TEXT,
  related_ids    TEXT,
  parent_id      TEXT,
  deleted_at     DATETIME,
  closed_at      DATETIME,
  close_reason   TEXT,
  notes          TEXT,
  created_at     DATETIME,
  updated_at     DATETIME,
  PRIMARY KEY (repo_slug, issue_id)
);

CREATE TABLE IF NOT EXISTS substrate_dependencies (
  repo_slug      TEXT NOT NULL,
  issue_id       TEXT NOT NULL,
  dep_issue_id   TEXT NOT NULL,
  relation       TEXT NOT NULL,
  created_at     DATETIME,
  PRIMARY KEY (repo_slug, issue_id, dep_issue_id)
);

CREATE TABLE IF NOT EXISTS specialist_jobs (
  repo_slug      TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  specialist     TEXT NOT NULL,
  status         TEXT NOT NULL,
  chain_id       TEXT,
  epic_id        TEXT,
  chain_kind     TEXT,
  worktree       TEXT,
  last_output    TEXT,
  created_at     DATETIME,
  updated_at     DATETIME,
  updated_at_ms  INTEGER,
  PRIMARY KEY (repo_slug, job_id)
);

CREATE TABLE IF NOT EXISTS specialist_job_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_slug      TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS substrate_job_link (
  repo_slug      TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  issue_id       TEXT NOT NULL,
  substrate_type TEXT NOT NULL,
  substrate_id   TEXT NOT NULL,
  created_at     DATETIME,
  PRIMARY KEY (repo_slug, job_id, issue_id)
);

CREATE TABLE IF NOT EXISTS sources (
  source_key     TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  path           TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK(origin IN ('discovered', 'manual')),
  status         TEXT NOT NULL,
  discovered_at  DATETIME,
  last_seen_at   DATETIME
);

CREATE TABLE IF NOT EXISTS materialization_state (
  source_key        TEXT PRIMARY KEY,
  cursor            TEXT CHECK (cursor IS NULL OR json_valid(cursor)),
  last_run_at       DATETIME,
  last_success_at   DATETIME,
  last_status       TEXT,
  last_error        TEXT
);
`;

const MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS idx_substrate_issues_repo_state ON substrate_issues(repo_slug, state)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_issues_repo_priority ON substrate_issues(repo_slug, priority)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_issues_repo_type ON substrate_issues(repo_slug, issue_type)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_dependencies_repo_issue ON substrate_dependencies(repo_slug, issue_id)",
  "CREATE INDEX IF NOT EXISTS idx_specialist_jobs_repo_status ON specialist_jobs(repo_slug, status)",
  "CREATE INDEX IF NOT EXISTS idx_specialist_job_events_repo_job ON specialist_job_events(repo_slug, job_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_job_link_repo_substrate ON substrate_job_link(repo_slug, substrate_type, substrate_id)",
  "CREATE INDEX IF NOT EXISTS idx_sources_kind_status ON sources(kind, status)",
];

export function createXtrmDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  ensureSpecialistJobsUpdatedAtMsColumn(db);
  ensureSubstrateIssuesColumns(db);
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  
  return db;
}

function ensureSpecialistJobsUpdatedAtMsColumn(db: Database): void {
  const row = db.query("PRAGMA table_info(specialist_jobs)").all() as Array<{ name: string }>;
  if (row.some((column) => column.name === "updated_at_ms")) return;
  db.exec("ALTER TABLE specialist_jobs ADD COLUMN updated_at_ms INTEGER");
}

function ensureSubstrateIssuesColumns(db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(substrate_issues)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of [
    ["priority", "INTEGER"],
    ["issue_type", "TEXT"],
    ["owner", "TEXT"],
    ["labels", "TEXT"],
    ["related_ids", "TEXT"],
    ["parent_id", "TEXT"],
    ["closed_at", "DATETIME"],
    ["close_reason", "TEXT"],
    ["notes", "TEXT"],
  ] as const) {
    if (columns.has(column[0])) {
      console.log(`xtrm-store: ALTER substrate_issues ADD COLUMN ${column[0]} ${column[1]} [already-present]`);
      continue;
    }
    console.log(`xtrm-store: ALTER substrate_issues ADD COLUMN ${column[0]} ${column[1]} [added]`);
    db.exec(`ALTER TABLE substrate_issues ADD COLUMN ${column[0]} ${column[1]}`);
  }
}
