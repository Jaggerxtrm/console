import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BeadsSnapshotSource } from "../../../src/core/materializer/beads-snapshot-source.ts";

function createStateDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE materialization_state (source_key TEXT PRIMARY KEY, cursor TEXT, last_run_at DATETIME, last_success_at DATETIME, last_status TEXT, last_error TEXT)");
  return db;
}

describe("BeadsSnapshotSource", () => {
  it("falls back to jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beads-snapshot-"));
    await writeFile(join(dir, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "A", title: "Alpha", status: "open", priority: 2, issue_type: "task", created_at: "2026-05-24T00:00:00.000Z", updated_at: "2026-05-24T00:00:00.000Z", dependencies: [] }),
    ].join("\n") + "\n");
    const db = createStateDb();
    const source = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, doltClient: { getIssues: async () => { throw new Error("no dolt"); } }, xtrmDb: db });
    const rows = await source.readSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].dependencies).toEqual([]);
    await rm(dir, { recursive: true, force: true });
    db.close();
  });

  it("returns true only when both signals match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beads-snapshot-"));
    await writeFile(join(dir, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "A", title: "Alpha", status: "open", priority: 2, issue_type: "task", created_at: "2026-05-24T00:00:00.000Z", updated_at: "2026-05-24T00:00:00.000Z", dependencies: [] }),
    ].join("\n") + "\n");
    const mtimeMs = (await stat(join(dir, "issues.jsonl"))).mtimeMs;
    const db = createStateDb();
    db.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("beads:1", JSON.stringify({ dolt_commit_hash: "abc", jsonl_mtime_ms: mtimeMs }));
    const source = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, doltCommitHash: "abc", xtrmDb: db });
    expect(await source.shouldSkipRead()).toBe(true);
    await rm(dir, { recursive: true, force: true });
    db.close();
  });

  it("returns false for same commit hash and different mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beads-snapshot-"));
    await writeFile(join(dir, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "A", title: "Alpha", status: "open", priority: 2, issue_type: "task", created_at: "2026-05-24T00:00:00.000Z", updated_at: "2026-05-24T00:00:00.000Z", dependencies: [] }),
    ].join("\n") + "\n");
    const mtimeMs = (await stat(join(dir, "issues.jsonl"))).mtimeMs;
    const db = createStateDb();
    db.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("beads:1", JSON.stringify({ dolt_commit_hash: "abc", jsonl_mtime_ms: mtimeMs + 1 }));
    const source = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, doltCommitHash: "abc", xtrmDb: db });
    expect(await source.shouldSkipRead()).toBe(false);
    await rm(dir, { recursive: true, force: true });
    db.close();
  });

  it("returns false for different commit hash and same mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beads-snapshot-"));
    await writeFile(join(dir, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "A", title: "Alpha", status: "open", priority: 2, issue_type: "task", created_at: "2026-05-24T00:00:00.000Z", updated_at: "2026-05-24T00:00:00.000Z", dependencies: [] }),
    ].join("\n") + "\n");
    const mtimeMs = (await stat(join(dir, "issues.jsonl"))).mtimeMs;
    const db = createStateDb();
    db.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("beads:1", JSON.stringify({ dolt_commit_hash: "zzz", jsonl_mtime_ms: mtimeMs }));
    const source = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, doltCommitHash: "abc", xtrmDb: db });
    expect(await source.shouldSkipRead()).toBe(false);
    await rm(dir, { recursive: true, force: true });
    db.close();
  });

  it("returns false when either signal is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beads-snapshot-"));
    await writeFile(join(dir, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "A", title: "Alpha", status: "open", priority: 2, issue_type: "task", created_at: "2026-05-24T00:00:00.000Z", updated_at: "2026-05-24T00:00:00.000Z", dependencies: [] }),
    ].join("\n") + "\n");
    const mtimeMs = (await stat(join(dir, "issues.jsonl"))).mtimeMs;
    const db = createStateDb();
    db.query("INSERT INTO materialization_state (source_key, cursor, last_status) VALUES (?, ?, 'success')").run("beads:1", JSON.stringify({ dolt_commit_hash: null, jsonl_mtime_ms: mtimeMs }));
    const source = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, xtrmDb: db });
    expect(await source.shouldSkipRead()).toBe(false);
    db.query("UPDATE materialization_state SET cursor = ? WHERE source_key = ?").run(JSON.stringify({ dolt_commit_hash: "abc", jsonl_mtime_ms: null }), "beads:1");
    const source2 = new BeadsSnapshotSource({ sourceKey: "beads:1", beadsPath: dir, doltCommitHash: "abc", xtrmDb: db });
    expect(await source2.shouldSkipRead()).toBe(false);
    await rm(dir, { recursive: true, force: true });
    db.close();
  });
});
