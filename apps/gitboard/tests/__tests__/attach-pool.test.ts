import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAttachPool } from "../../src/server/observability/attach-pool.ts";

function seedObservabilityDb(path: string, rows: Array<{ beadId: string; status: string; updatedAtMs: number }>): void {
  const db = new Database(path, { create: true });
  try {
    createRequiredSchema(db);
    insertRows(db, rows);
  } finally {
    db.close();
  }
}

function seedObservabilityDbWithoutJobsTable(path: string): void {
  const db = new Database(path, { create: true });
  try {
    db.exec("CREATE TABLE unrelated_table (id INTEGER PRIMARY KEY);");
  } finally {
    db.close();
  }
}

function createRequiredSchema(db: Database): void {
  db.exec(`
    CREATE TABLE specialist_jobs (
      job_id TEXT PRIMARY KEY,
      bead_id TEXT NOT NULL,
      chain_id TEXT,
      epic_id TEXT,
      chain_kind TEXT,
      status TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      specialist TEXT
    );
  `);
}

function insertRows(db: Database, rows: Array<{ beadId: string; status: string; updatedAtMs: number }>): void {
  const insert = db.prepare("INSERT INTO specialist_jobs (job_id, bead_id, chain_id, epic_id, chain_kind, status, updated_at_ms, specialist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let index = 0;
  for (const row of rows) {
    index += 1;
    insert.run(`job-${index}`, row.beadId, null, null, null, row.status, row.updatedAtMs, "executor");
  }
}

describe("createAttachPool", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("rejects v0 db missing specialist_jobs table", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-attach-pool-"));
    roots.push(root);
    const dbPath = join(root, "observability.db");
    seedObservabilityDbWithoutJobsTable(dbPath);
    const warn = vi.fn();
    const pool = createAttachPool([
      { repoSlug: "repo-a", repoPath: root, dbPath, mtimeMs: 0 },
    ], { logger: { warn } });

    const attached = pool.withAttached((db, repos) => ({ count: repos.length, rows: db.prepare("PRAGMA database_list").all() }));

    expect(attached.count).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("schema_version");
  });

  it("accepts v0 db with required observability tables", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-attach-pool-"));
    roots.push(root);
    const dbPath = join(root, "observability.db");
    seedObservabilityDb(dbPath, [{ beadId: "bead-2", status: "closed", updatedAtMs: 2 }]);
    const pool = createAttachPool([
      { repoSlug: "repo-b", repoPath: root, dbPath, mtimeMs: 0 },
    ]);

    const jobs = pool.withAttached((db) => db.prepare("SELECT count(*) AS count FROM repo_repo_b_0.specialist_jobs").get() as { count: number });

    expect(jobs.count).toBe(1);
  });

  it("keeps all discovered dbs represented in coverage when more than sqlite attach limit exist", async () => {
    const warn = vi.fn();
    const repos = Array.from({ length: 11 }, (_, index) => {
      const root = mkdtempSync(join(tmpdir(), `gitboard-attach-pool-${index}-`));
      roots.push(root);
      const dbPath = join(root, "observability.db");
      seedObservabilityDb(dbPath, [{ beadId: `bead-${index}`, status: "running", updatedAtMs: index + 1 }]);
      return { repoSlug: `repo-${index}`, repoPath: root, dbPath, mtimeMs: 0 };
    });

    const pool = createAttachPool(repos, { logger: { warn } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const coverage = pool.getCoverage();

    expect(coverage.totalDiscovered).toBe(11);
    expect(coverage.attached.length).toBeLessThanOrEqual(8);
    expect(new Set([...coverage.attached, ...coverage.skipped.map((item) => item.slug)]).size).toBe(11);
    expect(coverage.skipped.some((item) => item.reason === "evicted (capacity)")).toBe(true);
    expect(coverage.skipped.length).toBeGreaterThan(0);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("Skip observability db"))).toBe(false);
  });
});
