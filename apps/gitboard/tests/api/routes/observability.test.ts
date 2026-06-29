import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createAttachPool } from "../../../src/server/observability/attach-pool.ts";
import { createMetricsDao } from "../../../src/server/observability/metrics-dao.ts";
import { createObservabilityRouter } from "../../../src/api/routes/observability.ts";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-observability-"));
  db = new Database(join(dir, "repo.db"), { create: true });
  db.exec(`
    CREATE TABLE specialist_jobs (job_id TEXT, bead_id TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, status TEXT, specialist TEXT, updated_at_ms INTEGER);
    CREATE TABLE specialist_job_metrics (job_id TEXT, model TEXT, started_at_ms INTEGER, completed_at_ms INTEGER, elapsed_ms INTEGER, active_runtime_ms INTEGER, total_turns INTEGER, total_tools INTEGER, tool_call_counts_json TEXT, token_trajectory_json TEXT, context_trajectory_json TEXT, stall_gaps_json TEXT, run_complete_json TEXT, updated_at_ms INTEGER);
    CREATE TABLE specialist_results (job_id TEXT, output TEXT);
  `);
  db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?) ").run("job-1", "bead-1", null, null, null, "waiting", "reviewer", Date.now());
  db.prepare("INSERT INTO specialist_job_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "job-1",
    "model-x",
    10,
    30,
    20,
    20,
    3,
    2,
    '{"tool-a":2}',
    '[{"token_usage":{"input_tokens":5,"output_tokens":7,"cache_creation_tokens":1,"cache_read_tokens":2,"total_tokens":15}}]',
    '[{"context_pct":0.8}]',
    '[{"start_ms":10,"end_ms":18}]',
    '{"status":"complete","stale_warning":1}',
    Date.now(),
  );
  db.prepare("INSERT INTO specialist_results VALUES (?, ?)").run("job-1", "Verdict: PASS");
});

afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

describe("GET /api/console/observability/summary", () => {
  it("returns new summary shape", async () => {
    const pool = createAttachPool([{ repoSlug: "repo", repoPath: dir, dbPath: join(dir, "repo.db"), mtimeMs: 0 }]);
    const dao = createMetricsDao(pool);
    const app = new Hono();
    app.route("/api/console/observability", createObservabilityRouter(dao));

    const res = await app.fetch(new Request("http://localhost/api/console/observability/summary?range=7d"));
    expect(res.status).toBe(200);
    const json = await res.json() as { tokens: { totals: { total: number } }; reliability: Array<{ specialist: string }>; slowestJobs: Array<{ jobId: string }>; reviewerOutcomes: { pass: number } };
    expect(typeof json.tokens.totals.total).toBe("number");
    expect(json.reliability[0]?.specialist).toBe("reviewer");
    expect(json.slowestJobs[0]?.jobId).toBe("job-1");
    expect(json.reviewerOutcomes.pass).toBe(1);
  });
});
