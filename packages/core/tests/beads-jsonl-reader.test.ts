import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBeadsIssuesFromJsonl } from "../src/state/beads-jsonl-reader.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readBeadsIssuesFromJsonl", () => {
  it("preserves backup issue, dependency, and label fallback", async () => {
    const beadsPath = await mkdtemp(join(tmpdir(), "beads-jsonl-backup-"));
    roots.push(beadsPath);
    await mkdir(join(beadsPath, "backup"));
    await writeFile(join(beadsPath, "backup", "issues.jsonl"), [
      JSON.stringify({ id: "legacy.1", title: "Legacy parent", status: "open", priority: 1, issue_type: "epic", created_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "legacy.2", title: "Legacy child", status: "open", priority: 2, issue_type: "task", created_at: "2026-01-01T00:00:00Z" }),
    ].join("\n"));
    await writeFile(join(beadsPath, "backup", "dependencies.jsonl"), JSON.stringify({ issue_id: "legacy.2", depends_on_id: "legacy.1", type: "parent-child" }));
    await writeFile(join(beadsPath, "backup", "labels.jsonl"), JSON.stringify({ issue_id: "legacy.2", label: "migration" }));

    const issues = await readBeadsIssuesFromJsonl(beadsPath);

    expect(issues).toHaveLength(2);
    expect(issues[1]).toMatchObject({
      id: "legacy.2",
      labels: ["migration"],
      dependencies: [{ id: "legacy.1", title: "Legacy parent", dependency_type: "parent-child" }],
    });
  });

  it("prefers live issues and ignores non-issue typed rows", async () => {
    const beadsPath = await mkdtemp(join(tmpdir(), "beads-jsonl-live-"));
    roots.push(beadsPath);
    await writeFile(join(beadsPath, "issues.jsonl"), [
      JSON.stringify({ _type: "memory", id: "memory.1", title: "not an issue" }),
      JSON.stringify({ _type: "issue", id: "live.1", title: "Live", status: "open" }),
    ].join("\n"));

    expect((await readBeadsIssuesFromJsonl(beadsPath)).map((issue) => issue.id)).toEqual(["live.1"]);
  });
});
