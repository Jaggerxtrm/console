import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAttachPool } from "../../src/observability/attach-pool.ts";

function seed(path: string, compatible: boolean): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(compatible
      ? `CREATE TABLE specialist_jobs (job_id TEXT PRIMARY KEY, bead_id TEXT, chain_id TEXT, epic_id TEXT, chain_kind TEXT, status TEXT, updated_at_ms INTEGER, specialist TEXT);`
      : "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
  } finally {
    db.close();
  }
}

describe("observability attach pool", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("attaches compatible databases and rejects incompatible schemas", async () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-attach-"));
    roots.push(root);
    const good = join(root, "good.db");
    const bad = join(root, "bad.db");
    seed(good, true);
    seed(bad, false);
    const warn = vi.fn();
    const pool = createAttachPool([
      { repoSlug: "good", repoPath: root, dbPath: good, mtimeMs: 0 },
      { repoSlug: "bad", repoPath: root, dbPath: bad, mtimeMs: 0 },
    ], { logger: { warn } });

    await pool.ready;
    expect(pool.getCoverage()).toMatchObject({ attached: ["good"], totalDiscovered: 2 });
    expect(pool.getCoverage().skipped).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skip observability db"));
  });

  it("retains coverage for entries evicted by the attach limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-capacity-"));
    roots.push(root);
    const entries = Array.from({ length: 3 }, (_, index) => {
      const dbPath = join(root, `repo-${index}.db`);
      seed(dbPath, true);
      return { repoSlug: `repo-${index}`, repoPath: root, dbPath, mtimeMs: 0 };
    });
    const pool = createAttachPool(entries, { maxAttached: 2 });

    await pool.ready;
    const coverage = pool.getCoverage();
    expect(coverage.totalDiscovered).toBe(3);
    expect(coverage.attached).toHaveLength(2);
    expect(coverage.skipped).toContainEqual({ slug: "repo-0", reason: "evicted (capacity)" });
  });
});
