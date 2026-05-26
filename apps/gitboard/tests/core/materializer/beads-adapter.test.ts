import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    writeFileSync(join(beadsPath, "issues.jsonl"), `${JSON.stringify({ _type: "issue", id: "A", title: "Alpha", description: "one", status: "open", priority: 1, issue_type: "bug", owner: "alice", labels: ["ui"], related_ids: ["B"], parent_id: null, notes: "note", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", dependencies: [{ id: "B", dependency_type: "blocks" }] })}\n`);

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
  });

  it("coerces non-string issue fields before sqlite bind", async () => {
    const root = mkdtempSync(join(tmpdir(), "beads-adapter-"));
    tempDirs.push(root);
    const beadsPath = join(root, ".beads");
    mkdirSync(beadsPath, { recursive: true });
    writeFileSync(join(beadsPath, "issues.jsonl"), `${JSON.stringify({ _type: "issue", id: "A", title: { text: "Alpha" }, description: { rich: true }, notes: ["fallback", 1], status: "open", priority: 3, issue_type: "feature", owner: null, labels: ["l1", "l2"], related_ids: ["R1"], parent_id: "P1", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", dependencies: [{ id: "B", dependency_type: "blocks" }] })}\n`);

    const xtrmDb = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const adapter = new BeadsAdapter({ sourceKey: "beads:proj-1", projectId: "proj-1", beadsPath, xtrmDb });

    expect(() => adapter.write(xtrmDb, {
      rows: [{
        repo_slug: "proj-1",
        issue_id: "A",
        title: { text: "Alpha" } as never,
        body: { rich: true } as never,
        state: "open",
        priority: 3,
        issue_type: "feature",
        owner: null,
        labels: JSON.stringify(["l1", "l2"]),
        related_ids: JSON.stringify(["R1"]),
        parent_id: "P1",
        deleted_at: null,
        closed_at: null,
        close_reason: null,
        notes: "note",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
      dependencies: [],
    })).not.toThrow();

    const issue = xtrmDb.query("SELECT title, body FROM substrate_issues WHERE repo_slug = ? AND issue_id = ?").get("proj-1", "A") as { title: string | null; body: string | null } | undefined;
    expect(issue?.title).toBe('{"text":"Alpha"}');
    expect(issue?.body).toBe('{"rich":true}');
  });
});
