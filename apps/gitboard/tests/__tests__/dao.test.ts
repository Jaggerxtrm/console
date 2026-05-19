import { afterEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachPool } from "../../src/server/observability/attach-pool.js";
import { createObservabilityDao } from "../../src/server/observability/dao.js";

function makeDb(path: string, rows: Array<{ beadId: string; chainId: string | null; epicId: string | null; chainKind: string | null; status: string; updatedAtMs: number }>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`
      CREATE TABLE specialist_jobs (
        bead_id TEXT NOT NULL,
        chain_id TEXT,
        epic_id TEXT,
        chain_kind TEXT,
        status TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);

    const insert = db.prepare("INSERT INTO specialist_jobs VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(row.beadId, row.chainId, row.epicId, row.chainKind, row.status, row.updatedAtMs);
  } finally {
    db.close();
  }
}

describe("observability dao", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("returns bead rows across repos", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-"));
    roots.push(root);

    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 2000 },
    ]);
    makeDb(join(repoB, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-2", epicId: "epic-1", chainKind: "reviewer", status: "starting", updatedAtMs: 1000 },
    ]);

    const pool = createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
      { repoSlug: "repo-b", repoPath: repoB, dbPath: join(repoB, "observability.db"), mtimeMs: 1 },
    ]);
    const dao = createObservabilityDao(pool);

    expect(dao.jobsByBead("bead-1")).toEqual([
      expect.objectContaining({ repoSlug: "repo-a", beadId: "bead-1", updatedAt: new Date(2000).toISOString() }),
      expect.objectContaining({ repoSlug: "repo-b", beadId: "bead-1", updatedAt: new Date(1000).toISOString() }),
    ]);
  });

  it("returns in-flight jobs ordered by newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-"));
    roots.push(root);

    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 1000 },
      { beadId: "bead-2", chainId: "chain-2", epicId: "epic-2", chainKind: "reviewer", status: "done", updatedAtMs: 3000 },
    ]);
    makeDb(join(repoB, "observability.db"), [
      { beadId: "bead-3", chainId: "chain-3", epicId: "epic-3", chainKind: "executor", status: "starting", updatedAtMs: 2000 },
    ]);

    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
      { repoSlug: "repo-b", repoPath: repoB, dbPath: join(repoB, "observability.db"), mtimeMs: 1 },
    ]));

    expect(dao.inFlightJobs().map((job) => job.updatedAt)).toEqual([
      new Date(2000).toISOString(),
      new Date(1000).toISOString(),
    ]);
  });

  it("preserves chain kind in chain fetch", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-"));
    roots.push(root);

    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 2000 },
    ]);
    makeDb(join(repoB, "observability.db"), [
      { beadId: "bead-2", chainId: "chain-1", epicId: "epic-1", chainKind: "reviewer", status: "starting", updatedAtMs: 1000 },
    ]);

    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
      { repoSlug: "repo-b", repoPath: repoB, dbPath: join(repoB, "observability.db"), mtimeMs: 1 },
    ]));

    expect(dao.chainById("chain-1").map((job) => job.chainKind)).toEqual(["executor", "reviewer"]);
  });

  it("tags epic rows with repo slug", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-dao-"));
    roots.push(root);

    const repoA = join(root, "repo-a");
    makeDb(join(repoA, "observability.db"), [
      { beadId: "bead-1", chainId: "chain-1", epicId: "epic-1", chainKind: "executor", status: "running", updatedAtMs: 2000 },
    ]);

    const dao = createObservabilityDao(createAttachPool([
      { repoSlug: "repo-a", repoPath: repoA, dbPath: join(repoA, "observability.db"), mtimeMs: 1 },
    ]));

    expect(dao.epicById("epic-1")).toEqual([
      expect.objectContaining({ repoSlug: "repo-a", epicId: "epic-1" }),
    ]);
  });
});
