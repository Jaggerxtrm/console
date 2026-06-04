import { describe, expect, it } from "vitest";
import { filterIssuesForFeed } from "../../../../src/dashboard/components/beads/feedSearch.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

describe("IssueFeed search", () => {
  it("filters by id prefix", () => {
    const issues = [
      issue("forge-58ek", "Memory leak", "open"),
      issue("forge-58zz", "Cache leak", "in_progress"),
      issue("forge-abcd", "Deploy polish", "open"),
    ];

    const result = filterIssuesForFeed(issues, "forge-58");

    expect(result.issues.map((issue) => issue.id)).toEqual(["forge-58ek", "forge-58zz"]);
    expect(result.prefixMatchCount).toBe(2);
    expect(result.totalMatches).toBe(2);
  });

  it("matches title text", () => {
    const issues = [
      issue("forge-58ek", "Memory leak", "open"),
      issue("forge-58zz", "Cache leak", "in_progress"),
      issue("forge-abcd", "Deploy polish", "open"),
    ];

    const result = filterIssuesForFeed(issues, "deploy");

    expect(result.issues.map((issue) => issue.id)).toEqual(["forge-abcd"]);
    expect(result.titleMatchCount).toBe(1);
  });

  it("returns full set for blank query", () => {
    const issues = [issue("forge-1", "Alpha", "open"), issue("forge-2", "Beta", "closed")];

    const result = filterIssuesForFeed(issues, "   ");

    expect(result.issues).toHaveLength(2);
    expect(result.totalMatches).toBe(2);
  });
});

function issue(id: string, title: string, status: string, dependencies: BeadIssue["dependencies"] = []): BeadIssue {
  return {
    id,
    title,
    description: null,
    status,
    priority: 1,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    project_id: "gitboard",
    dependencies,
    related_ids: [],
    labels: [],
  };
}
