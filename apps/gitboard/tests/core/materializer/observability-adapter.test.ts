import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { Materializer } from "../../../src/core/materializer/index.ts";
import { createObservabilityAdapter } from "../../../src/core/materializer/observability-adapter.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) Bun.spawnSync(["rm", "-rf", dir]);
  }
});

describe("observability adapter", () => {
  it("returns zero cursor on fresh obs db", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-cursor-"));
    tempDirs.push(root);
    const dbPath = join(root, "obs.sqlite");

    const adapter = createObservabilityAdapter(dbPath, "repo-1");

    await expect(adapter.cursor()).resolves.toEqual({ updated_at_ms: 0, event_rowid: 0 });
  });

  it("materializes specialist_jobs rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-"));
    tempDirs.push(root);
    const obsDbPath = join(root, "observability.db");
    const xtrmDbPath = join(root, "xtrm.sqlite");
    const obsDb = new Database(obsDbPath);
    obsDb.run("CREATE TABLE specialist_jobs (job_id TEXT, specialist TEXT, status TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, worktree_column TEXT, last_output TEXT, updated_at_ms INTEGER)");
    obsDb.run("CREATE TABLE specialist_events (id INTEGER, job_id TEXT, seq INTEGER, specialist TEXT, bead_id TEXT, t TEXT, type TEXT, event_json TEXT)");
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
});
