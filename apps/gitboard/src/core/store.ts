import { Database } from "bun:sqlite";

export const TABLES = [
  "sessions",
  "messages",
  "specialist_events",
  "github_events",
  "github_commits",
  "github_repos",
  "github_prs",
  "github_issues",
  "github_repo_poll_state",
] as const;

export type TableName = (typeof TABLES)[number];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  specialist_id    TEXT,
  role             TEXT NOT NULL,
  tmux_session     TEXT NOT NULL,
  status           TEXT NOT NULL,
  task             TEXT,
  parent_id        TEXT,
  started_at       DATETIME,
  updated_at       DATETIME,
  ended_at         DATETIME,
  last_activity    DATETIME,
  stalled_since    DATETIME,
  escalation_level INTEGER DEFAULT 0,
  exit_reason      TEXT,
  log_file         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session  TEXT NOT NULL,
  to_session    TEXT NOT NULL,
  type          TEXT NOT NULL CHECK(type IN (
                  'task', 'result', 'status', 'follow_up',
                  'worker_done', 'spawn_request', 'escalation', 'health_check'
                )),
  content       TEXT NOT NULL,
  payload       TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal'
                  CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
  thread_id     TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  read          BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_inbox    ON messages (to_session, read);
CREATE INDEX IF NOT EXISTS idx_thread   ON messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_priority ON messages (priority, created_at);

CREATE TABLE IF NOT EXISTS specialist_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id   TEXT NOT NULL,
  hook            TEXT NOT NULL CHECK(hook IN (
    'pre_render','post_render','pre_execute','post_execute')),
  timestamp       DATETIME NOT NULL,
  specialist_name TEXT NOT NULL,
  specialist_version TEXT,
  session_id      TEXT,
  thread_id       TEXT,
  payload         TEXT NOT NULL,
  backend         TEXT,
  duration_ms     INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  token_cache_read INTEGER,
  token_cache_creation INTEGER,
  token_reasoning INTEGER,
  token_tool      INTEGER,
  usage_source    TEXT,
  cost_usd        REAL,
  cost_usd_provenance TEXT,
  status          TEXT,
  error_type      TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_invocation ON specialist_events(invocation_id);
CREATE INDEX IF NOT EXISTS idx_events_specialist ON specialist_events(specialist_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_session    ON specialist_events(session_id);

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
  paused_until          DATETIME
);

-- Releases ingested via /repos/<x>/releases polling (forge-nwdr).
-- Replaces the prior approach of surfacing releases only via ReleaseEvent rows
-- in github_events, which was bound to the user-events 300-event/90-day window.
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
`;

export function createDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  // Idempotent migrations for existing databases
  const migrations = [
    "ALTER TABLE github_commits ADD COLUMN message_full TEXT",
    "ALTER TABLE github_prs ADD COLUMN additions INTEGER",
    "ALTER TABLE github_prs ADD COLUMN deletions INTEGER",
    "ALTER TABLE github_prs ADD COLUMN changed_files INTEGER",
    // forge-nwdr: release polling watermark + ETag per repo
    "ALTER TABLE github_repo_poll_state ADD COLUMN last_release_published_at DATETIME",
    "ALTER TABLE github_repo_poll_state ADD COLUMN release_etag TEXT",
    // forge-szc0: legacy specialist_events is token-first. cost_usd remains
    // nullable/deferred and is authoritative only with explicit provenance.
    "ALTER TABLE specialist_events ADD COLUMN token_cache_read INTEGER",
    "ALTER TABLE specialist_events ADD COLUMN token_cache_creation INTEGER",
    "ALTER TABLE specialist_events ADD COLUMN token_reasoning INTEGER",
    "ALTER TABLE specialist_events ADD COLUMN token_tool INTEGER",
    "ALTER TABLE specialist_events ADD COLUMN usage_source TEXT",
    "ALTER TABLE specialist_events ADD COLUMN cost_usd_provenance TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  return db;
}
