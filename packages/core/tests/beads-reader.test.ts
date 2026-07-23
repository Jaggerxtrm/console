import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsReader } from "../src/state/beads-reader.ts";

describe("BeadsReader", () => {
  let db: Database;
  let tempDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE issues (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
        priority INTEGER NOT NULL, issue_type TEXT NOT NULL, owner TEXT, created_at TEXT NOT NULL,
        created_by TEXT, updated_at TEXT, closed_at TEXT, close_reason TEXT
      );
      CREATE TABLE dependencies (from_issue TEXT, to_issue TEXT, dependency_type TEXT);
      CREATE TABLE issue_labels (issue_id TEXT, label TEXT);
    `);
    tempDir = await mkdtemp(join(tmpdir(), "core-beads-reader-"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads filtered SQLite issues with dependencies and labels", async () => {
    db.exec(`
      INSERT INTO issues VALUES
        ('open-1', 'Open issue', 'needle', 'open', 1, 'task', NULL, '2026-01-02', NULL, NULL, NULL, NULL),
        ('closed-1', 'Closed issue', NULL, 'closed', 2, 'bug', 'dawid', '2026-01-01', 'dawid', '2026-01-03', '2026-01-03', 'done');
      INSERT INTO dependencies VALUES ('open-1', 'closed-1', 'blocks');
      INSERT INTO issue_labels VALUES ('open-1', 'phase:2');
    `);

    const issues = await new BeadsReader(db as never).getIssues({ status: ["open"], search: "needle" });

    expect(issues).toEqual([
      expect.objectContaining({
        id: "open-1",
        updated_at: "2026-01-02",
        labels: ["phase:2"],
        dependencies: [expect.objectContaining({ id: "closed-1", dependency_type: "blocks" })],
      }),
    ]);
  });

  it("parses current and legacy JSONL dependency schemas", () => {
    const [issue] = BeadsReader.parseIssueLine(JSON.stringify({
      id: "issue-1",
      title: "Issue",
      dependencies: [
        { depends_on_issue_id: "new-target", type: "blocks" },
        { to_issue: "old-target", dependency_type: "related" },
        { depends_on_id: "middle-target", type: "tracks" },
      ],
      labels: ["one", 2],
      related_ids: [3],
    }));

    expect(issue?.dependencies.map(({ id, dependency_type }) => ({ id, dependency_type }))).toEqual([
      { id: "new-target", dependency_type: "blocks" },
      { id: "old-target", dependency_type: "related" },
      { id: "middle-target", dependency_type: "tracks" },
    ]);
    expect(issue).toMatchObject({ labels: ["one", "2"], related_ids: ["3"], priority: 2, project_id: "" });
  });

  it("rejects malformed and non-issue JSONL records without throwing", () => {
    expect(BeadsReader.parseIssueLine("not-json")).toEqual([]);
    expect(BeadsReader.parseIssueLine('{"_type":"memory","id":"m1"}')).toEqual([]);
    expect(BeadsReader.parseIssueLine('{"title":"missing id"}')).toEqual([]);
  });

  it("reads memory and interaction files with existing defaults", async () => {
    const knowledgePath = join(tempDir, "knowledge.jsonl");
    const interactionsPath = join(tempDir, "interactions.jsonl");
    await writeFile(knowledgePath, '{"id":"m1","content":"Learned","created_at":"2026-01-01"}\n');
    await writeFile(interactionsPath, '{"id":"i1","created_at":"2026-01-02","actor":"codex","issue_id":"issue-1"}\n');
    const reader = new BeadsReader(db as never);

    expect(await reader.getMemories(knowledgePath)).toEqual([
      expect.objectContaining({ id: "m1", type: "learned", tags: [], project_id: "" }),
    ]);
    expect(await reader.getInteractions(interactionsPath)).toEqual([
      expect.objectContaining({ id: "i1", kind: "tool_call", project_id: "" }),
    ]);
  });

  it("preserves fail-soft file parsing and agent inference", async () => {
    const malformedPath = join(tempDir, "malformed.jsonl");
    await writeFile(malformedPath, '{"id":"m1"}\nnot-json\n');
    const reader = new BeadsReader(db as never);

    expect(await reader.getMemories(malformedPath)).toEqual([]);
    expect(await reader.getInteractions(join(tempDir, "missing.jsonl"))).toEqual([]);
    expect(BeadsReader.inferAgent("Claude Sonnet")).toBe("claude");
    expect(BeadsReader.inferAgent("QWEN coder")).toBe("qwen");
    expect(BeadsReader.inferAgent("gemini-2")).toBe("gemini");
    expect(BeadsReader.inferAgent("gpt-5")).toBe("other");
  });
});
