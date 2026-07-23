import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", async () => await import("../__mocks__/bun-sqlite.ts"));
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachPool } from "../../src/observability/attach-pool.ts";
import { createObservabilityDao } from "../../src/observability/dao.ts";

function makeDb(
  path: string,
  rows: Array<{ beadId: string; chainId: string | null; epicId: string | null; chainKind: string | null; status: string; updatedAtMs: number; lastOutput?: string | null }>,
  options: { withLastOutput?: boolean } = {},
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  const withLastOutput = options.withLastOutput ?? false;
  try {
    db.exec(`
      CREATE TABLE specialist_jobs (
        job_id TEXT PRIMARY KEY,
        bead_id TEXT NOT NULL,
        chain_id TEXT,
        epic_id TEXT,
        chain_kind TEXT,
        status TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        specialist TEXT${withLastOutput ? ",\n        last_output TEXT" : ""}
      );
    `);
    const insert = withLastOutput
      ? db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      : db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    let counter = 0;
    for (const row of rows) {
      counter += 1;
      if (withLastOutput) {
        insert.run(`job-${counter}`, row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs, "explorer", row.lastOutput ?? null);
      } else {
        insert.run(`job-${counter}`, row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs, "explorer");
      }
    }
  } finally { db.close(); }
}

describe("observability dao", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.length = 0; });

  it("returns bead rows across repos", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-")); roots.push(root);
    const repoA = join(root, "repo-a"); const repoB = join(root, "repo-b");
    makeDb(join(repoA, "observability.db"), [{ beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 2000 }]);
    makeDb(join(repoB, "observability.db"), [{ beadId: "bead-1", chainId: "chain-2", epicId: "epic-1", chainKind: "reviewer", status: "starting", updatedAtMs: 1000 }]);
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
      { repoSlug: "repo-b", repoPath: repoB, dbPath: join(repoB, "observability.db"), mtimeMs: 1 },
    ]));
    expect(dao.jobsByBead("bead-1")).toEqual([
      expect.objectContaining({ repoSlug: "repo-a", beadId: "bead-1", updatedAt: new Date(2000).toISOString() }),
      expect.objectContaining({ repoSlug: "repo-b", beadId: "bead-1", updatedAt: new Date(1000).toISOString() }),
    ]);
  });

  it("returns in-flight jobs ordered by newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-")); roots.push(root);
    const repoA = join(root, "repo-a"); const repoB = join(root, "repo-b");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 1000 },
      { beadId: "bead-2", chainId: "chain-2", epicId: "epic-2", chainKind: "reviewer", status: "done", updatedAtMs: 3000 },
    ]);
    makeDb(join(repoB, "observability.db"), [{ beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "executor", status: "starting", updatedAtMs: 2000 }]);
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
      { repoSlug: "repo-b", repoPath: repoB, dbPath: join(repoB, "observability.db"), mtimeMs: 1 },
    ]));
    expect(dao.inFlightJobs().map((job) => job.updatedAt)).toEqual([new Date(2000).toISOString(), new Date(1000).toISOString()]);
  });

  it("returns recent jobs ordered by newest first and limited", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-")); roots.push(root);
    const repoA = join(root, "repo-a");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: null, epicId: null, chainKind: null, status: "done", updatedAtMs: 1000 },
      { beadId: "bead-2", chainId: null, epicId: null, chainKind: null, status: "error", updatedAtMs: 3000 },
      { beadId: "bead-3", chainId: null, epicId: null, chainKind: null, status: "running", updatedAtMs: 4000 },
      { beadId: "bead-4", chainId: null, epicId: null, chainKind: null, status: "cancelled", updatedAtMs: 2000 },
    ]);
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
    ]));
    expect(dao.recentJobs(2).map((job) => [job.status, job.updatedAt])).toEqual([ ["error", new Date(3000).toISOString()], ["cancelled", new Date(2000).toISOString()] ]);
  });

  // Distinct slug (`repo-lo`) avoids hitting the module-level slugHasLastOutput
  // cache populated by the earlier tests (which all use legacy `repo-a/b` slugs
  // without the column).
  it("surfaces last_output when the column is present and NULL when blank", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-")); roots.push(root);
    const repoLo = join(root, "repo-lo");
    makeDb(
      join(repoLo, "observability.db"),
      [
        { beadId: "bead-1", chainId: null, epicId: null, chainKind: null, status: "running", updatedAtMs: 1000, lastOutput: "turn 5: editing src/foo.ts" },
        { beadId: "bead-2", chainId: null, epicId: null, chainKind: null, status: "waiting", updatedAtMs: 2000, lastOutput: null },
      ],
      { withLastOutput: true },
    );
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-lo", repoPath: repoLo, dbPath: join(repoLo, "observability.db"), mtimeMs: 1 },
    ]));
    const jobs = dao.inFlightJobs();
    expect(jobs.find((job) => job.beadId === "bead-1")?.lastOutput).toBe("turn 5: editing src/foo.ts");
    expect(jobs.find((job) => job.beadId === "bead-2")?.lastOutput).toBeNull();
  });

  // Distinct slug (`repo-legacy`) to keep this test independent of cache state.
  it("falls back to null lastOutput when the column is missing on the schema", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-")); roots.push(root);
    const repoLegacy = join(root, "repo-legacy");
    makeDb(join(repoLegacy, "observability.db"), [
      { beadId: "bead-1", chainId: null, epicId: null, chainKind: null, status: "running", updatedAtMs: 1000 },
    ]);
    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-legacy", repoPath: repoLegacy, dbPath: join(repoLegacy, "observability.db"), mtimeMs: 1 },
    ]));
    expect(dao.inFlightJobs()[0].lastOutput).toBeNull();
  });
});
