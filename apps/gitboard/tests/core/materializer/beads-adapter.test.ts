import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { Materializer } from "../../../src/core/materializer/index.ts";
import { BeadsAdapter } from "../../../src/core/materializer/beads-adapter.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) Bun.spawnSync(["rm", "-rf", dir]);
  }
});

describe("BeadsAdapter", () => {
  it("delegates snapshot + diff and materializer advances cursor only on success", async () => {
    const root = mkdtempSync(join(tmpdir(), "beads-adapter-"));
    tempDirs.push(root);
    const beadsPath = join(root, ".beads");
    mkdirSync(beadsPath, { recursive: true });
    writeFileSync(join(beadsPath, "issues.jsonl"), `${JSON.stringify({ _type: "issue", id: "A", title: "Alpha", description: "one", status: "open", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", dependencies: [{ id: "B", dependency_type: "blocks" }] })}\n`);

    const xtrmDb = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const adapter = new BeadsAdapter({ sourceKey: "beads:proj-1", projectId: "proj-1", beadsPath, xtrmDb });
    const materializer = new Materializer(xtrmDb);
    materializer.register("beads:proj-1", adapter);

    const snapshot = await adapter.snapshot();
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.dependencies).toHaveLength(1);

    await materializer.runOnce("beads:proj-1");
    const cursorRow = xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get("beads:proj-1") as { cursor: string } | undefined;
    expect(cursorRow?.cursor).toContain("snapshot_hash");

    writeFileSync(join(beadsPath, "issues.jsonl"), `${JSON.stringify({ _type: "issue", id: "A", title: "Alpha v2", description: "two", status: "open", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", dependencies: [{ id: "B", dependency_type: "blocks" }] })}\n`);

    const cursorBeforeFailure = xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get("beads:proj-1") as { cursor: string } | undefined;
    const failingMaterializer = new Materializer(xtrmDb, undefined, { afterWritesBeforeCursorAdvance: () => { throw new Error("boom"); } });
    failingMaterializer.register("beads:proj-1", adapter);
    await expect(failingMaterializer.runOnce("beads:proj-1")).rejects.toThrow("boom");
    const cursorAfterFailure = xtrmDb.query("SELECT cursor FROM materialization_state WHERE source_key = ?").get("beads:proj-1") as { cursor: string } | undefined;
    expect(cursorAfterFailure?.cursor).toBe(cursorBeforeFailure?.cursor);
  });
});
