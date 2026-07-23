import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../../src/state/database.ts";
import { Materializer } from "../../src/materializer/materializer.ts";
import { createObservabilityAdapter } from "../../src/materializer/observability-adapter.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("observability adapter", () => {
  it("returns zero cursor on fresh obs db", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-cursor-"));
    tempDirs.push(root);
    const dbPath = join(root, "obs.sqlite");

    const adapter = createObservabilityAdapter(dbPath, "repo-1");

    await expect(adapter.cursor()).resolves.toEqual({ updated_at_ms: 0, event_rowid: 0, forensic_rowid: 0, job_id: "" });
  });

  it("materializes specialist_jobs rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-"));
    tempDirs.push(root);
    const obsDbPath = join(root, "observability.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = new Database(obsDbPath);
    obsDb.exec("CREATE TABLE specialist_jobs (job_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
    obsDb.exec("CREATE TABLE specialist_events (id INTEGER, job_id TEXT, seq INTEGER, specialist TEXT, bead_id TEXT, t TEXT, type TEXT, event_json TEXT)");
    obsDb.query(
      "INSERT INTO specialist_jobs (job_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("job-1", "planner", "running", "chain-1", "epic-1", "epic", "/tmp/worktree", "hello", 1000);

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    await materializer.runOnce("obs:repo-1");

    const row = xtrmDb.query("SELECT source_key, last_status FROM materialization_state WHERE source_key = ?").get("obs:repo-1") as { source_key: string; last_status: string } | undefined;
    expect(row?.source_key).toBe("obs:repo-1");
    expect(row?.last_status).toBe("success");

    const countRow = xtrmDb.query("SELECT COUNT(*) AS count FROM specialist_jobs").get() as { count: number };
    expect(countRow.count).toBeGreaterThan(0);
  });

  it("materializes forensic envelopes, evidence refs, and job metrics", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-forensic-"));
    tempDirs.push(root);
    const obsDbPath = join(root, "observability.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = new Database(obsDbPath);
    obsDb.exec("CREATE TABLE specialist_jobs (job_id TEXT, bead_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
    obsDb.exec("CREATE TABLE specialist_job_metrics (job_id TEXT, model TEXT, total_turns INTEGER, total_tools INTEGER, token_trajectory_json TEXT)");
    obsDb.exec("CREATE TABLE specialist_forensic_events (job_id TEXT, seq INTEGER, t INTEGER, schema_version TEXT, event_family TEXT, event_name TEXT, participant_kind TEXT, participant_role TEXT, participant_id TEXT, redaction_status TEXT, event_json TEXT)");
    obsDb.query("INSERT INTO specialist_jobs (job_id, bead_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("job-1", "bead-1", "executor", "done", "chain-1", null, "executor", "/tmp/worktree", "done", 1000);
    obsDb.query("INSERT INTO specialist_job_metrics (job_id, model, total_turns, total_tools, token_trajectory_json) VALUES (?, ?, ?, ?, ?)")
      .run("job-1", "model-x", 3, 2, JSON.stringify([{ token_usage: { input_tokens: 5, output_tokens: 7, cache_read_tokens: 2, cache_creation_tokens: 1, reasoning_tokens: 4, tool_tokens: 6 } }]));
    obsDb.query("INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name, participant_kind, participant_role, participant_id, redaction_status, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("job-1", 1, 1700000000000, "xtrm.forensic.v1", "job", "job.completed", "specialist", "executor", "p1", "clean", JSON.stringify({
        schema_version: "xtrm.forensic.v1",
        timestamp: "2023-11-14T22:13:20.000Z",
        t_unix_ms: 1700000000000,
        seq: 1,
        severity: "info",
        event_family: "job",
        event_name: "job.completed",
        event_version: 1,
        resource: { participant_kind: "specialist", participant_role: "executor" },
        correlation: { job_id: "job-1", trace_id: "trace-1" },
        body: { evidence_refs: [{ kind: "commit", id: "commit-1", sha: "abc" }] },
        redaction: { status: "clean" },
        trace: { trace_id: "trace-1" },
        links: { dashboard: "/console" },
      }));

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    await materializer.runOnce("obs:repo-1");

    const job = xtrmDb.query("SELECT turns, tools, model, token_input, token_output, token_cache_read, token_cache_creation, token_reasoning, token_tool, usage_source FROM specialist_jobs WHERE job_id = 'job-1'").get() as Record<string, unknown>;
    expect(job).toMatchObject({ turns: 3, tools: 2, model: "model-x", token_input: 5, token_output: 7, token_cache_read: 2, token_cache_creation: 1, token_reasoning: 4, token_tool: 6, usage_source: "specialist_job_metrics" });

    const event = xtrmDb.query("SELECT schema_version, event_family, event_name, correlation_json, body_json, trace_json, links_json FROM xtrm_forensic_events WHERE job_id = 'job-1'").get() as Record<string, string>;
    expect(event.schema_version).toBe("xtrm.forensic.v1");
    expect(event.event_name).toBe("job.completed");
    expect(JSON.parse(event.correlation_json)).toMatchObject({ job_id: "job-1", trace_id: "trace-1" });
    expect(JSON.parse(event.body_json)).toMatchObject({ evidence_refs: [{ kind: "commit", id: "commit-1", sha: "abc" }] });
    expect(JSON.parse(event.trace_json)).toMatchObject({ trace_id: "trace-1" });
    expect(JSON.parse(event.links_json)).toMatchObject({ dashboard: "/console" });

    const evidence = xtrmDb.query("SELECT evidence_kind, evidence_id, job_id, ref_json FROM xtrm_evidence_refs WHERE job_id = 'job-1'").get() as Record<string, string>;
    expect(evidence.evidence_kind).toBe("commit");
    expect(evidence.evidence_id).toBe("commit-1");
    expect(JSON.parse(evidence.ref_json)).toMatchObject({ sha: "abc" });
  });

  it("keeps specialist job bead ids unambiguous when metrics also expose bead_id", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-bead-id-"));
    tempDirs.push(root);
    const obsDbPath = join(root, "observability.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = new Database(obsDbPath);
    obsDb.exec("CREATE TABLE specialist_jobs (job_id TEXT, bead_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
    obsDb.exec("CREATE TABLE specialist_job_metrics (job_id TEXT, bead_id TEXT, model TEXT, total_turns INTEGER, total_tools INTEGER, token_trajectory_json TEXT)");
    obsDb.exec("CREATE TABLE specialist_events (id INTEGER, job_id TEXT, seq INTEGER, specialist TEXT, bead_id TEXT, t TEXT, type TEXT, event_json TEXT)");
    obsDb.query("INSERT INTO specialist_jobs (job_id, bead_id, specialist, status, chain_id, epic_id, chain_kind, worktree_column, last_output, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("job-1", "job-bead", "executor", "done", "chain-1", null, "executor", "/tmp/worktree", "done", 1000);
    obsDb.query("INSERT INTO specialist_job_metrics (job_id, bead_id, model, total_turns, total_tools, token_trajectory_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("job-1", "metrics-bead", "model-x", 1, 1, JSON.stringify([]));

    const xtrmDb = createXtrmDatabase(xtrmDbPath);
    const materializer = new Materializer(xtrmDb);
    materializer.register("obs:repo-1", createObservabilityAdapter(obsDbPath, "repo-1"));

    await materializer.runOnce("obs:repo-1");

    const row = xtrmDb.query("SELECT bead_id FROM specialist_jobs WHERE job_id = ?").get("job-1") as { bead_id: string } | undefined;
    expect(row?.bead_id).toBe("job-bead");
  });
});
