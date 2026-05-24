import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp } from "../../src/api/server.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";

const tmpDir = join(process.cwd(), ".tmp-specialists-fallback");
const logPath = join(process.cwd(), "tests/smoke/p1-specialists-fallback.log");

async function main(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });

  const db = createXtrmDatabase(join(tmpDir, "app.sqlite"));
  const xtrmDb = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
  seedXtrmOnly(xtrmDb);

  process.env.OBSERVABILITY_ROOTS = tmpDir;
  process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "0";
  const appFresh = createApp(db, xtrmDb);
  const freshRes = await appFresh.app.request("/api/specialists/jobs/in-flight");
  const freshJson = await freshRes.json() as Record<string, unknown>;
  if (freshRes.status !== 200) throw new Error(`xtrm route failed: ${freshRes.status}`);
  if (!Array.isArray(freshJson.jobs) || (freshJson.jobs as unknown[]).length !== 1) throw new Error("expected xtrm-seeded job");

  process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "1";
  const appFallback = createApp(db, xtrmDb);
  const fallbackRes = await appFallback.app.request("/api/specialists/jobs/in-flight");
  const fallbackJson = await fallbackRes.json() as Record<string, unknown>;
  const fallbackJobs = Array.isArray(fallbackJson.jobs) ? (fallbackJson.jobs as unknown[]) : [];
  if (fallbackRes.status !== 200 && fallbackRes.status !== 404) throw new Error(`unexpected fallback status ${fallbackRes.status}`);
  if (fallbackJobs.length !== 0) throw new Error("expected live fallback to ignore xtrm-only seed");

  const summary = `${new Date().toISOString()} fresh_status=${freshRes.status} fresh_jobs=${(freshJson.jobs as unknown[]).length} fallback_status=${fallbackRes.status} fallback_jobs=${fallbackJobs.length}`;
  writeFileSync(logPath, `${summary}\n`);
  db.close();
  xtrmDb.close();
  console.log(summary);
}

function seedXtrmOnly(db: Database): void {
  db.exec(`
    CREATE TABLE substrate_job_link (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      substrate_type TEXT NOT NULL,
      substrate_id TEXT NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (repo_slug, job_id, issue_id)
    );
    CREATE TABLE specialist_jobs (
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      specialist TEXT NOT NULL,
      status TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      worktree TEXT,
      last_output TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      updated_at_ms INTEGER,
      PRIMARY KEY (repo_slug, job_id)
    );
    CREATE TABLE specialist_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_slug TEXT NOT NULL,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE materialization_state (
      source_key TEXT PRIMARY KEY,
      cursor TEXT,
      last_run_at DATETIME,
      last_success_at DATETIME,
      last_status TEXT,
      last_error TEXT
    );
  `);
  db.prepare("INSERT INTO substrate_job_link (repo_slug, job_id, issue_id, substrate_type, substrate_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run("repo-a", "job-1", "bead-1", "bead", "bead-1");
  db.prepare("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "executor", "running", "chain-1", null, "executor", null, "xtrm-only", "2026-01-01", "2026-01-01", 1000);
  db.prepare("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_success_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success')").run("obs:repo-a", JSON.stringify({ updated_at_ms: 1000, event_rowid: 0 }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
