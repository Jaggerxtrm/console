import { describe, expect, it } from "vitest";
import { BeadsAdapter, type MaterializerBeadIssue } from "../src/materializer/beads-adapter.ts";
import type { MaterializedIssue } from "../src/materializer/types.ts";

interface FakeStatement {
  run: (...args: unknown[]) => void;
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
}

interface FakeDb {
  queries: Array<{ sql: string; args: unknown[]; method: "run" | "all" | "get" }>;
  query(sql: string): FakeStatement;
}

function createFakeDb(overrides: { allFor?: (sql: string) => unknown[]; getFor?: (sql: string) => unknown } = {}): FakeDb {
  const queries: Array<{ sql: string; args: unknown[]; method: "run" | "all" | "get" }> = [];
  const db: FakeDb = {
    queries,
    query(sql: string): FakeStatement {
      return {
        run: (...args: unknown[]) => queries.push({ sql, args, method: "run" }),
        all: (...args: unknown[]) => {
          queries.push({ sql, args, method: "all" });
          return overrides.allFor?.(sql) ?? [];
        },
        get: (...args: unknown[]) => {
          queries.push({ sql, args, method: "get" });
          return overrides.getFor?.(sql) ?? undefined;
        },
      };
    },
  };
  return db;
}

function makeIssue(partial: Partial<MaterializerBeadIssue> & { id: string }): MaterializerBeadIssue {
  return {
    title: partial.id,
    description: null,
    status: "open",
    owner: null,
    dependencies: [],
    related_ids: [],
    labels: [],
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as MaterializerBeadIssue;
}

describe("core BeadsAdapter boundary", () => {
  it("normalizes issues and materializes edges without host glue", async () => {
    const issues: MaterializerBeadIssue[] = [
      makeIssue({ id: "epic-1", title: "Org epic", issue_type: "epic" }),
      makeIssue({
        id: "chain-1",
        title: "Review chain",
        description: "<change-contract><goal>Ship</goal></change-contract>",
        issue_type: "molecule",
        labels: ["formula:review-fix", "kind:molecule"],
        metadata: { recommended_template: "review-fix" },
        dependencies: [{ id: "epic-1", dependency_type: "parent-child" }],
      }),
      makeIssue({
        id: "chain-1.1",
        title: "Step",
        description: "<step-contract><role>reviewer</role></step-contract>",
        parent_id: "chain-1",
        labels: ["kind:step"],
        dependencies: [{ id: "chain-1", dependency_type: "validates" }],
      }),
    ];
    const db = createFakeDb();
    const adapter = new BeadsAdapter({
      sourceKey: "beads:proj-1",
      projectId: "proj-1",
      xtrmDb: db as never,
      readSnapshot: async () => issues,
    });

    const snapshot = await adapter.snapshot();

    const byId = new Map(snapshot.rows.map((row) => [row.issue_id, row]));
    expect(byId.get("epic-1")?.runtime_kind).toBe("organizational_epic");
    expect(byId.get("chain-1")).toMatchObject({
      runtime_kind: "chain_molecule",
      formula_name: "review-fix",
      contract_kind: "change-contract",
      parent_id: "epic-1",
    });
    expect(byId.get("chain-1.1")?.runtime_kind).toBe("step");
    expect(JSON.parse(byId.get("chain-1")?.metadata_json ?? "{}")).toMatchObject({ metadata: { recommended_template: "review-fix" } });

    const relationPairs = snapshot.dependencies.map((dep) => `${dep.issue_id}->${dep.dep_issue_id}:${dep.relation}`).sort();
    expect(relationPairs).toEqual([
      "chain-1->epic-1:parent-child",
      "chain-1.1->chain-1:parent-child",
      "chain-1.1->chain-1:validates",
    ]);
  });

  it("write() emits upserts without tombstoning (delta path)", async () => {
    const issues = [makeIssue({ id: "A", title: "Alpha" })];
    const db = createFakeDb();
    const adapter = new BeadsAdapter({
      sourceKey: "beads:proj-1",
      projectId: "proj-1",
      xtrmDb: db as never,
      readSnapshot: async () => issues,
    });
    const snapshot = await adapter.snapshot();

    adapter.write(db as never, snapshot);

    const tombstoneCalls = db.queries.filter((entry) => entry.sql.includes("deleted_at = CURRENT_TIMESTAMP"));
    expect(tombstoneCalls).toHaveLength(0);
    const issueUpserts = db.queries.filter((entry) => entry.sql.startsWith("INSERT INTO substrate_issues"));
    expect(issueUpserts).toHaveLength(1);
  });

  it("writeFull() tombstones active issues missing from the snapshot (resync path)", async () => {
    const issues = [makeIssue({ id: "A", title: "Alpha" })];
    const db = createFakeDb({
      allFor: (sql) => (sql.includes("deleted_at IS NULL") ? [{ issue_id: "A" }, { issue_id: "GONE" }] : []),
    });
    const adapter = new BeadsAdapter({
      sourceKey: "beads:proj-1",
      projectId: "proj-1",
      xtrmDb: db as never,
      readSnapshot: async () => issues,
    });
    const snapshot = await adapter.snapshot();

    adapter.writeFull(db as never, snapshot);

    const tombstoneRuns = db.queries.filter((entry) => entry.sql.includes("deleted_at = CURRENT_TIMESTAMP") && entry.method === "run");
    expect(tombstoneRuns).toHaveLength(1);
    expect(tombstoneRuns[0].args).toContain("GONE");
  });

  it("changesSince emits tombstone rows for disappeared issues", async () => {
    const first = [makeIssue({ id: "A", title: "Alpha" }), makeIssue({ id: "B", title: "Beta" })];
    const db = createFakeDb({
      allFor: (sql) => (sql.includes("FROM substrate_issues") ? (first.map((issue) => ({ repo_slug: "proj-1", issue_id: issue.id, title: String(issue.title), state: "open" })) as MaterializedIssue[]) : []),
      getFor: () => ({ cursor: JSON.stringify({ snapshot_hash: "prev" }) }),
    });
    const adapter = new BeadsAdapter({
      sourceKey: "beads:proj-1",
      projectId: "proj-1",
      xtrmDb: db as never,
      readSnapshot: async () => [makeIssue({ id: "A", title: "Alpha-v2" })],
    });

    const delta = await adapter.changesSince();

    const upsertIds = delta.rows.filter((row) => row.state !== "deleted").map((row) => row.issue_id);
    const tombstoneIds = delta.rows.filter((row) => row.state === "deleted").map((row) => row.issue_id);
    expect(upsertIds).toEqual(["A"]);
    expect(tombstoneIds).toEqual(["B"]);
    expect((delta.cursor as { snapshot_hash: string }).snapshot_hash).toBeTruthy();
  });

  it("cursor reads stored snapshot hash from xtrmDb", async () => {
    const db = createFakeDb({ getFor: () => ({ cursor: JSON.stringify({ snapshot_hash: "stored-hash" }) }) });
    const adapter = new BeadsAdapter({
      sourceKey: "beads:proj-1",
      projectId: "proj-1",
      xtrmDb: db as never,
      readSnapshot: async () => [],
    });

    const cursor = await adapter.cursor();

    expect(cursor).toEqual({ snapshot_hash: "stored-hash" });
  });
});
