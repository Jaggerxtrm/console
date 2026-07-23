import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../src/server/routes/specialists.ts";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";

const tmpDir = join(process.cwd(), ".tmp-specialists-fallback");
const logPath = join(process.cwd(), "tests/smoke/p1-specialists-fallback.log");

async function main(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });

  const xtrmDb = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
  seedXtrmOnly(xtrmDb);

  process.env.OBSERVABILITY_ROOTS = tmpDir;
  process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "0";
  const appFresh = createSpecialistsApp(xtrmDb);
  const freshRes = await appFresh.request("/api/specialists/jobs/in-flight");
  const freshJson = await freshRes.json() as Record<string, unknown>;
  if (freshRes.status !== 200) throw new Error(`xtrm route failed: ${freshRes.status}`);
  if (!Array.isArray(freshJson.jobs) || (freshJson.jobs as unknown[]).length !== 1) throw new Error("expected xtrm-seeded job");

  process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "1";
  const appFallback = createSpecialistsApp(xtrmDb);
  const fallbackRes = await appFallback.request("/api/specialists/jobs/in-flight");
  const fallbackJson = await fallbackRes.json() as Record<string, unknown>;
  const fallbackJobs = Array.isArray(fallbackJson.jobs) ? (fallbackJson.jobs as unknown[]) : [];
  if (fallbackRes.status !== 200 && fallbackRes.status !== 404) throw new Error(`unexpected fallback status ${fallbackRes.status}`);
  if (fallbackJobs.length !== 0) throw new Error("expected live fallback to ignore xtrm-only seed");

  const summary = `${new Date().toISOString()} fresh_status=${freshRes.status} fresh_jobs=${(freshJson.jobs as unknown[]).length} fallback_status=${fallbackRes.status} fallback_jobs=${fallbackJobs.length}`;
  writeFileSync(logPath, `${summary}\n`);
  xtrmDb.close();
  console.log(summary);
}

function createSpecialistsApp(db: Database): Hono {
  return new Hono().route("/api/specialists", createSpecialistsRouter(undefined, db, {
    listRepos: () => [],
    getEpoch: () => 0,
  }));
}

function seedXtrmOnly(db: Database): void {
  db.prepare("INSERT INTO substrate_job_link (repo_slug, job_id, issue_id, substrate_type, substrate_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run("repo-a", "job-1", "bead-1", "bead", "bead-1");
  db.prepare("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "executor", "running", "chain-1", null, "executor", null, "xtrm-only", "2026-01-01", "2026-01-01", 1000);
  db.prepare("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_success_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success')").run("obs:repo-a", JSON.stringify({ updated_at_ms: 1000, event_rowid: 0 }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
