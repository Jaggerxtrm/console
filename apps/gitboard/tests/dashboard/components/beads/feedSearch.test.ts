import { describe, expect, it } from "vitest";
import { filterIssuesForFeed } from "../../../../src/dashboard/components/beads/feedSearch.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

describe("feedSearch", () => {
  it("returns original identity for empty queries", () => {
    const issues = [issue("forge-58ek", "Memory leak"), issue("forge-59aa", "Other")];

    expect(filterIssuesForFeed(issues, "").issues).toBe(issues);
    expect(filterIssuesForFeed(issues, "   ").issues).toBe(issues);
  });

  it("matches id prefixes and title substrings case-insensitively", () => {
    const issues = [issue("forge-58ek", "Memory leak"), issue("forge-58zz", "Cache repair"), issue("forge-abcd", "Leak audit")];

    expect(filterIssuesForFeed(issues, "FORGE-58").issues.map((item) => item.id)).toEqual(["forge-58ek", "forge-58zz"]);
    expect(filterIssuesForFeed(issues, "leak").issues.map((item) => item.id)).toEqual(["forge-58ek", "forge-abcd"]);
  });

  it("preserves filtered identity for repeated query and issue references", () => {
    const issues = [issue("forge-58ek", "Memory leak"), issue("forge-59aa", "Other")];

    const first = filterIssuesForFeed(issues, "leak");
    const second = filterIssuesForFeed(issues, " leak ");

    expect(second).toBe(first);
    expect(second.issues).toBe(first.issues);
    expect(second.prefixMatchCount).toBe(0);
    expect(second.titleMatchCount).toBe(1);
    expect(second.totalMatches).toBe(1);
  });
});

function issue(id: string, title: string): BeadIssue {
  return {
    id,
    title,
    description: null,
    status: "open",
    priority: 1,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    project_id: "gitboard",
    dependencies: [],
    related_ids: [],
    labels: [],
  };
}
