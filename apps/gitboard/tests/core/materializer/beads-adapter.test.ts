import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    if (dir) rmSync(dir, { recursive: true, force: true });
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

  it("preserves Beads runtime graph semantics for pre-Substrate chains", async () => {
    const root = mkdtempSync(join(tmpdir(), "beads-adapter-"));
    tempDirs.push(root);
    const beadsPath = join(root, ".beads");
    mkdirSync(beadsPath, { recursive: true });
    const rootContract = "<change-contract><goal>Ship telemetry</goal></change-contract>";
    const stepContract = "<step-contract><role>reviewer</role></step-contract>";
    writeFileSync(join(beadsPath, "issues.jsonl"), [
      JSON.stringify({ _type: "issue", id: "epic-1", title: "Org epic", description: "north star", status: "open", priority: 1, issue_type: "epic", labels: [], dependencies: [] }),
      JSON.stringify({ _type: "issue", id: "chain-1", title: "Review chain", description: rootContract, status: "open", priority: 1, issue_type: "molecule", labels: ["formula:review-fix", "kind:molecule"], metadata: { recommended_template: "review-fix" }, dependencies: [{ id: "epic-1", dependency_type: "parent-child" }] }),
      JSON.stringify({ _type: "issue", id: "chain-1.1", title: "Reviewer", description: stepContract, status: "open", priority: 2, issue_type: "task", parent_id: "chain-1", labels: ["kind:step", "role:reviewer", "edge:validates->chain-1"], dependencies: [{ id: "chain-1", dependency_type: "validates" }] }),
    ].join("\n"));

    const xtrmDb = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const adapter = new BeadsAdapter({ sourceKey: "beads:proj-1", projectId: "proj-1", beadsPath, xtrmDb });
    const materializer = new Materializer(xtrmDb);
    materializer.register("beads:proj-1", adapter);

    await materializer.runOnce("beads:proj-1");

    const issues = xtrmDb.query("SELECT issue_id, runtime_kind, formula_name, contract_kind, contract_xml, metadata_json FROM substrate_issues WHERE repo_slug = ? ORDER BY issue_id").all("proj-1") as Array<{ issue_id: string; runtime_kind: string | null; formula_name: string | null; contract_kind: string | null; contract_xml: string | null; metadata_json: string | null }>;
    expect(issues).toEqual([
      expect.objectContaining({ issue_id: "chain-1", runtime_kind: "chain_molecule", formula_name: "review-fix", contract_kind: "change-contract", contract_xml: rootContract }),
      expect.objectContaining({ issue_id: "chain-1.1", runtime_kind: "step", contract_kind: "step-contract", contract_xml: stepContract }),
      expect.objectContaining({ issue_id: "epic-1", runtime_kind: "organizational_epic" }),
    ]);
    expect(JSON.parse(issues.find((issue) => issue.issue_id === "chain-1")?.metadata_json ?? "{}")).toMatchObject({ metadata: { recommended_template: "review-fix" } });

    const edges = xtrmDb.query("SELECT from_issue_id, to_issue_id, relation FROM substrate_issue_edges WHERE repo_slug = ? ORDER BY from_issue_id, relation").all("proj-1");
    expect(edges).toEqual([
      { from_issue_id: "chain-1", to_issue_id: "epic-1", relation: "parent-child" },
      { from_issue_id: "chain-1.1", to_issue_id: "chain-1", relation: "parent-child" },
      { from_issue_id: "chain-1.1", to_issue_id: "chain-1", relation: "validates" },
    ]);
  });
});
