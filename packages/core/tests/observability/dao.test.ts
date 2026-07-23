import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAttachPool } from "../../src/observability/attach-pool.ts";
import { createObservabilityDao } from "../../src/observability/dao.ts";

function makeDb(path: string, withLastOutput: boolean, status: string, updatedAtMs: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`CREATE TABLE specialist_jobs (job_id TEXT PRIMARY KEY, bead_id TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, status TEXT, updated_at_ms INTEGER, specialist TEXT${withLastOutput ? ", last_output TEXT" : ""});`);
    const columns = withLastOutput ? "job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist, last_output" : "job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist";
    db.prepare(`INSERT INTO specialist_jobs (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?${withLastOutput ? ", ?" : ""})`).run("job-1", "bead-1", "chain-1", "epic-1", "executor", status, updatedAtMs, "executor", ...(withLastOutput ? ["latest output"] : []));
  } finally {
    db.close();
  }
}

describe("observability DAO", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("reads in-flight jobs and preserves last-output compatibility", () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-dao-"));
    roots.push(root);
    const modern = join(root, "modern.db");
    const legacy = join(root, "legacy.db");
    makeDb(modern, true, "running", 2_000);
    makeDb(legacy, false, "running", 1_000);
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "modern-dao", repoPath: root, dbPath: modern, mtimeMs: 0 },
      { repoSlug: "legacy-dao", repoPath: root, dbPath: legacy, mtimeMs: 0 },
    ]));

    const jobs = dao.inFlightJobs();
    expect(jobs.map((job) => job.repoSlug)).toEqual(["modern-dao", "legacy-dao"]);
    expect(jobs[0]?.lastOutput).toBe("latest output");
    expect(jobs[1]?.lastOutput).toBeNull();
    expect(dao.inFlightJobs({ repoSlugs: ["legacy-dao"] })).toHaveLength(1);
  });
});
