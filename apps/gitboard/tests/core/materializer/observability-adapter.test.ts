import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("materializes specialist_jobs rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "obs-adapter-"));
    tempDirs.push(root);
    const dbPath = join(root, "xtrm.sqlite");
    const db = createXtrmDatabase(dbPath);
    db.query(
      "INSERT INTO specialist_jobs (repo_slug, job_id, specialist, status, chain_id, epic_id, chain_kind, worktree, last_output, created_at, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("repo-1", "job-1", "planner", "running", "chain-1", "epic-1", "epic", "/tmp/worktree", "hello", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", 1000);

    const materializer = new Materializer(db);
    materializer.register("obs:repo-1", createObservabilityAdapter(dbPath, "repo-1"));

    await materializer.runOnce("obs:repo-1");

    const row = db.query("SELECT source_key, last_status FROM materialization_state WHERE source_key = ?").get("obs:repo-1") as { source_key: string; last_status: string } | undefined;
    expect(row?.source_key).toBe("obs:repo-1");
    expect(row?.last_status).toBe("success");

    const countRow = db.query("SELECT COUNT(*) AS count FROM specialist_jobs").get() as { count: number };
    expect(countRow.count).toBeGreaterThan(0);
  });
});
