import { describe, expect, it } from "vitest";
import { filterIssuesForFeed } from "../../../../src/dashboard/components/beads/feedSearch.ts";
import type { BeadIssue } from "../../../../src/types/beads.ts";

describe("feedSearch", () => {
  it("returns original identity for empty queries", () => {
    const issues = [issue("forge-58ek", "Memory leak"), issue("forge-59aa", "Other")];

    expect(filterIssuesForFeed(issues, "").issues).toBe(issues);
    expect(filterIssuesForFeed(issues, "   ").issues).toBe(issues);
  });

  it("matches title, body, notes, labels, and dependency content fuzzily", () => {
    const issues = [
      issue("forge-58ek", "Memory leak", { description: "Investigate allocator pressure" }),
      issue("forge-ui", "Inspector polish", { notes: "Drawer should preserve scroll position" }),
      issue("forge-label", "Muted row", { labels: ["agentops"] }),
      issue("forge-dep", "Blocked row", { dependencies: [{ id: "forge-blocker", title: "Deploy blocker", status: "open", dependency_type: "blocked_by" }] }),
    ];

    expect(filterIssuesForFeed(issues, "allocater").issues.map((item) => item.id)).toEqual(["forge-58ek"]);
    expect(filterIssuesForFeed(issues, "preserve scroll").issues.map((item) => item.id)).toEqual(["forge-ui"]);
    expect(filterIssuesForFeed(issues, "agentops").matchByIssueId.get("forge-label")?.reason).toBe("label");
    expect(filterIssuesForFeed(issues, "deploy blocker").matchByIssueId.get("forge-dep")?.reason).toBe("dependency");
  });

  it("matches id prefixes and suppresses unrelated queries", () => {
    const issues = [issue("forge-58ek", "Memory leak"), issue("forge-58zz", "Cache repair"), issue("forge-abcd", "Leak audit")];

    expect(filterIssuesForFeed(issues, "FORGE-58").issues.map((item) => item.id)).toEqual(["forge-58ek", "forge-58zz"]);
    expect(filterIssuesForFeed(issues, "forge-58ek").matchByIssueId.get("forge-58ek")?.reason).toBe("id");
    expect(filterIssuesForFeed(issues, "totally unrelated query").issues).toEqual([]);
  });

  it("matches multi-keyword queries across fields and ranks exact title hits first", () => {
    const issues = [
      issue("forge-drawer", "Drawer inspector", { notes: "Canonical issue detail surface" }),
      issue("forge-search", "Search repair", { description: "Improve fuzzy keyword ranking in issues" }),
      issue("forge-noise", "Inspector metrics", { notes: "Unrelated drawer polish" }),
    ];

    expect(filterIssuesForFeed(issues, "drawer canonical").issues.map((item) => item.id)).toEqual(["forge-drawer"]);
    expect(filterIssuesForFeed(issues, "fuzzy issues").issues.map((item) => item.id)).toEqual(["forge-search"]);
    expect(filterIssuesForFeed(issues, "drawer inspector").issues.map((item) => item.id)[0]).toBe("forge-drawer");
  });

  it("tolerates small typos per token without matching arbitrary subsequences", () => {
    const issues = [
      issue("forge-alloc", "Allocator pressure", { description: "Memory subsystem investigation" }),
      issue("forge-alpha", "Alphabetical ordering", { description: "Completely different task" }),
    ];

    expect(filterIssuesForFeed(issues, "allocater pressure").issues.map((item) => item.id)).toEqual(["forge-alloc"]);
    expect(filterIssuesForFeed(issues, "atr").issues).toEqual([]);
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

function issue(id: string, title: string, overrides: Partial<BeadIssue> = {}): BeadIssue {
  return {
    id,
    title,
    description: overrides.description ?? null,
    notes: overrides.notes ?? null,
    status: overrides.status ?? "open",
    priority: overrides.priority ?? 1,
    issue_type: overrides.issue_type ?? "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    project_id: "gitboard",
    dependencies: overrides.dependencies ?? [],
    related_ids: overrides.related_ids ?? [],
    labels: overrides.labels ?? [],
  };
}
