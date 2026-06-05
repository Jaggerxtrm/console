import { Database } from "bun:sqlite";

export const XTRM_TABLES = [
  "github_events",
  "github_commits",
  "github_repos",
  "github_prs",
  "github_issues",
  "github_releases",
  "github_repo_poll_state",
  "substrate_issues",
  "substrate_dependencies",
  "substrate_issue_edges",
  "specialist_jobs",
  "specialist_job_events",
  "xtrm_forensic_events",
  "xtrm_evidence_refs",
  "substrate_job_link",
  "sources",
  "materialization_state",
] as const;

export type XtrmTableName = (typeof XTRM_TABLES)[number];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS github_events (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  repo            TEXT NOT NULL,
  branch          TEXT,
  actor           TEXT NOT NULL,
  action          TEXT,
  title           TEXT,
  body            TEXT,
  url             TEXT,
  additions       INTEGER,
  deletions       INTEGER,
  changed_files   INTEGER,
  commit_count    INTEGER,
  created_at      DATETIME NOT NULL,
  ingested_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gh_events_repo   ON github_events(repo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_events_type   ON github_events(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_events_date   ON github_events(created_at DESC);

CREATE TABLE IF NOT EXISTS github_commits (
  sha             TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  branch          TEXT,
  author          TEXT NOT NULL,
  message         TEXT NOT NULL,
  message_full    TEXT,
  url             TEXT,
  additions       INTEGER,
  deletions       INTEGER,
  changed_files   INTEGER,
  event_id        TEXT REFERENCES github_events(id),
  committed_at    DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gh_commits_repo  ON github_commits(repo, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_commits_event ON github_commits(event_id);

CREATE TABLE IF NOT EXISTS github_repos (
  full_name       TEXT PRIMARY KEY,
  display_name    TEXT,
  tracked         BOOLEAN DEFAULT TRUE,
  group_name      TEXT,
  last_polled_at  DATETIME,
  color           TEXT
);

CREATE INDEX IF NOT EXISTS idx_gh_repos_group ON github_repos(group_name);

CREATE TABLE IF NOT EXISTS github_prs (
  repo            TEXT NOT NULL,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  state           TEXT NOT NULL,
  author          TEXT NOT NULL,
  url             TEXT,
  additions       INTEGER,
  deletions       INTEGER,
  changed_files   INTEGER,
  comment_count   INTEGER DEFAULT 0,
  label_names     TEXT,
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME,
  merged_at       DATETIME,
  closed_at       DATETIME,
  PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS idx_gh_prs_repo  ON github_prs(repo, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_prs_state ON github_prs(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS github_issues (
  repo            TEXT NOT NULL,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  state           TEXT NOT NULL,
  author          TEXT NOT NULL,
  url             TEXT,
  comment_count   INTEGER DEFAULT 0,
  label_names     TEXT,
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME,
  closed_at       DATETIME,
  PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS idx_gh_issues_repo  ON github_issues(repo, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_issues_state ON github_issues(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS github_repo_poll_state (
  repo                  TEXT PRIMARY KEY,
  last_issue_updated_at  DATETIME,
  last_pr_updated_at     DATETIME,
  last_activity_at       DATETIME,
  issue_etag            TEXT,
  pr_etag               TEXT,
  paused_until          DATETIME,
  last_release_published_at DATETIME,
  release_etag          TEXT
);

CREATE TABLE IF NOT EXISTS github_releases (
  repo            TEXT NOT NULL,
  tag_name        TEXT NOT NULL,
  release_id      TEXT NOT NULL,
  name            TEXT,
  body            TEXT,
  html_url        TEXT,
  author_login    TEXT NOT NULL,
  published_at    DATETIME NOT NULL,
  created_at      DATETIME NOT NULL,
  PRIMARY KEY (repo, tag_name)
);
CREATE INDEX IF NOT EXISTS idx_gh_releases_repo ON github_releases(repo, published_at DESC);

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
  runtime_kind   TEXT,
  formula_name   TEXT,
  template_name  TEXT,
  contract_kind  TEXT,
  contract_xml   TEXT,
  metadata_json  TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
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

CREATE TABLE IF NOT EXISTS substrate_issue_edges (
  repo_slug      TEXT NOT NULL,
  from_issue_id  TEXT NOT NULL,
  to_issue_id    TEXT NOT NULL,
  relation       TEXT NOT NULL,
  created_at     DATETIME,
  PRIMARY KEY (repo_slug, from_issue_id, to_issue_id, relation)
);

CREATE TABLE IF NOT EXISTS specialist_jobs (
  repo_slug      TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  bead_id        TEXT,
  specialist     TEXT NOT NULL,
  status         TEXT NOT NULL,
  chain_id       TEXT,
  epic_id        TEXT,
  chain_kind     TEXT,
  worktree       TEXT,
  last_output    TEXT,
  turns          INTEGER,
  tools          INTEGER,
  model          TEXT,
  token_input    INTEGER,
  token_output   INTEGER,
  token_cache_read INTEGER,
  token_cache_creation INTEGER,
  token_reasoning INTEGER,
  token_tool     INTEGER,
  usage_source   TEXT,
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

CREATE TABLE IF NOT EXISTS xtrm_forensic_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key       TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,
  repo_slug        TEXT NOT NULL,
  job_id           TEXT,
  seq              INTEGER,
  t_unix_ms        INTEGER,
  timestamp        DATETIME,
  schema_version   TEXT NOT NULL,
  severity         TEXT,
  event_family     TEXT,
  event_name       TEXT,
  event_version    INTEGER,
  resource_json    TEXT NOT NULL CHECK(json_valid(resource_json)),
  correlation_json TEXT NOT NULL CHECK(json_valid(correlation_json)),
  body_json        TEXT NOT NULL CHECK(json_valid(body_json)),
  redaction_json   TEXT NOT NULL CHECK(json_valid(redaction_json)),
  trace_json       TEXT CHECK(trace_json IS NULL OR json_valid(trace_json)),
  links_json       TEXT CHECK(links_json IS NULL OR json_valid(links_json)),
  diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR json_valid(diagnostics_json)),
  envelope_json    TEXT NOT NULL CHECK(json_valid(envelope_json)),
  ingested_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_key, source_event_id)
);

CREATE TABLE IF NOT EXISTS xtrm_evidence_refs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key       TEXT NOT NULL,
  repo_slug        TEXT NOT NULL,
  evidence_id      TEXT NOT NULL,
  evidence_kind    TEXT NOT NULL,
  job_id           TEXT,
  issue_id         TEXT,
  event_source_id  TEXT,
  ref_json         TEXT NOT NULL CHECK(json_valid(ref_json)),
  created_at       DATETIME,
  ingested_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_key, evidence_id)
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
  "CREATE INDEX IF NOT EXISTS idx_substrate_issues_repo_runtime_kind ON substrate_issues(repo_slug, runtime_kind)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_dependencies_repo_issue ON substrate_dependencies(repo_slug, issue_id)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_issue_edges_repo_from ON substrate_issue_edges(repo_slug, from_issue_id)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_issue_edges_repo_to ON substrate_issue_edges(repo_slug, to_issue_id)",
  "CREATE INDEX IF NOT EXISTS idx_specialist_jobs_repo_status ON specialist_jobs(repo_slug, status)",
  "CREATE INDEX IF NOT EXISTS idx_specialist_jobs_repo_bead ON specialist_jobs(repo_slug, bead_id)",
  "CREATE INDEX IF NOT EXISTS idx_specialist_job_events_repo_job ON specialist_job_events(repo_slug, job_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_xtrm_forensic_repo_job_time ON xtrm_forensic_events(repo_slug, job_id, t_unix_ms, seq)",
  "CREATE INDEX IF NOT EXISTS idx_xtrm_forensic_event_name ON xtrm_forensic_events(event_family, event_name, t_unix_ms)",
  "CREATE INDEX IF NOT EXISTS idx_xtrm_evidence_repo_kind ON xtrm_evidence_refs(repo_slug, evidence_kind, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_substrate_job_link_repo_substrate ON substrate_job_link(repo_slug, substrate_type, substrate_id)",
  "CREATE INDEX IF NOT EXISTS idx_sources_kind_status ON sources(kind, status)",
];

export function createXtrmDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  ensureSpecialistJobsColumns(db);
  ensureSubstrateIssuesColumns(db);
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  
  return db;
}

function ensureSpecialistJobsColumns(db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(specialist_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of [
    ["bead_id", "TEXT"],
    ["updated_at_ms", "INTEGER"],
    ["turns", "INTEGER"],
    ["tools", "INTEGER"],
    ["model", "TEXT"],
    ["token_input", "INTEGER"],
    ["token_output", "INTEGER"],
    ["token_cache_read", "INTEGER"],
    ["token_cache_creation", "INTEGER"],
    ["token_reasoning", "INTEGER"],
    ["token_tool", "INTEGER"],
    ["usage_source", "TEXT"],
  ] as const) {
    if (columns.has(column[0])) {
      console.log(`xtrm-store: ALTER specialist_jobs ADD COLUMN ${column[0]} ${column[1]} [already-present]`);
      continue;
    }
    console.log(`xtrm-store: ALTER specialist_jobs ADD COLUMN ${column[0]} ${column[1]} [added]`);
    db.exec(`ALTER TABLE specialist_jobs ADD COLUMN ${column[0]} ${column[1]}`);
  }
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
    ["runtime_kind", "TEXT"],
    ["formula_name", "TEXT"],
    ["template_name", "TEXT"],
    ["contract_kind", "TEXT"],
    ["contract_xml", "TEXT"],
    ["metadata_json", "TEXT"],
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
