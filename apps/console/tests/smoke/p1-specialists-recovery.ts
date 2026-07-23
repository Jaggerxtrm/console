import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSpecialistsRouter } from "../../src/server/routes/specialists.ts";
import { Materializer } from "../../../../packages/core/src/materializer/materializer.ts";
import type { MaterializerAdapter } from "../../../../packages/core/src/materializer/types.ts";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";

const tmpDir = join(process.cwd(), ".tmp-specialists-kill");
const logPath = join(process.cwd(), "tests/smoke/p1-specialists-kill.log");

async function main(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(process.cwd(), "tests/smoke"), { recursive: true });

  process.env.OBSERVABILITY_ROOTS = tmpDir;
  process.env.GITBOARD_SPECIALISTS_LIVE_FALLBACK = "0";

  const xtrmDb = createXtrmDatabase(join(tmpDir, "xtrm.sqlite"));
  seedSpecialists(xtrmDb);

  const app = new Hono().route("/api/specialists", createSpecialistsRouter(undefined, xtrmDb, {
    listRepos: () => [],
    getEpoch: () => 0,
  }));
  const materializer = new Materializer(xtrmDb);
  const adapter = new EchoAdapter();
  adapter.seed([{ repo_slug: "repo-a", issue_id: "issue-1", key: "issue-1", title: "title-1", state: "open" }]);
  materializer.register("obs:test/repo", adapter);

  await materializer.runOnce("obs:test/repo");
  const initial = await app.request("/api/specialists/jobs/in-flight");
  if (initial.status !== 200) throw new Error(`initial specialists request failed: ${initial.status}`);
  const initialJson = await initial.json() as { jobs: unknown[] };
  if ((initialJson.jobs ?? []).length === 0) throw new Error("expected seeded specialists data");

  const failingMaterializer = new Materializer(xtrmDb, undefined, { afterWritesBeforeCursorAdvance: () => { throw new Error("simulated materializer failure"); } });
  failingMaterializer.register("obs:test/repo", adapter);
  try {
    await failingMaterializer.runOnce("obs:test/repo");
    throw new Error("expected materializer failure");
  } catch {
    // expected
  }

  const failedState = xtrmDb.query("SELECT last_status, last_error FROM materialization_state WHERE source_key = ?").get("obs:test/repo") as { last_status: string | null; last_error: string | null } | undefined;
  if (failedState?.last_status !== "error") throw new Error("materialization_state did not reflect failure");

  const afterFailure = await app.request("/api/specialists/jobs/in-flight");
  if (afterFailure.status !== 200) throw new Error(`specialists request after failure failed: ${afterFailure.status}`);
  const afterFailureJson = await afterFailure.json() as { jobs: unknown[] };
  if ((afterFailureJson.jobs ?? []).length === 0) throw new Error("specialists data blank after failure");

  const recoveryMaterializer = new Materializer(xtrmDb);
  recoveryMaterializer.register("obs:test/repo", adapter);
  await recoveryMaterializer.runOnce("obs:test/repo");
  const recoveredState = xtrmDb.query("SELECT last_status FROM materialization_state WHERE source_key = ?").get("obs:test/repo") as { last_status: string | null } | undefined;
  if (recoveredState?.last_status !== "success") throw new Error("materializer did not resume");

  const summary = `${new Date().toISOString()} initial_jobs=${initialJson.jobs.length} after_failure_jobs=${afterFailureJson.jobs.length} last_status=${recoveredState?.last_status}`;
  writeFileSync(logPath, `${summary}\n`);
  xtrmDb.close();
  console.log(summary);
}

class EchoAdapter implements MaterializerAdapter<Record<string, unknown>> {
  private rows: Array<Record<string, unknown>> = [];

  seed(rows: Array<Record<string, unknown>>): void { this.rows = rows; }
  async cursor(): Promise<Record<string, number>> { return { version: 0 }; }
  async changesSince(): Promise<{ cursor: Record<string, number>; rows: Array<Record<string, unknown>> }> {
    return { cursor: { version: 1 }, rows: this.rows };
  }
  async snapshot(): Promise<{ rows: Array<Record<string, unknown>> }> { return { rows: this.rows }; }
  write(): void {}
}

function seedSpecialists(db: Database): void {
  db.prepare("INSERT INTO substrate_job_link (repo_slug, job_id, issue_id, substrate_type, substrate_id, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").run("repo-a", "job-1", "bead-1", "bead", "bead-1");
  db.prepare("INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("repo-a", "job-1", "executor", "running", "chain-1", null, "executor", null, "seeded", "2026-01-01", "2026-01-01", 1000);
  db.prepare("INSERT INTO materialization_state (source_key, cursor, last_run_at, last_success_at, last_status) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'success')").run("obs:test/repo", JSON.stringify({ version: 1 }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
