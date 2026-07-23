import { describe, expect, it } from "vitest";
import { getFeedItemKey, type FeedItem } from "../../../../src/dashboard/components/beads/IssueFeed.tsx";
import type { BeadIssue } from "../../../../src/types/beads.ts";

const baseIssue: BeadIssue = {
  id: "forge-1",
  title: "Stable row",
  description: null,
  status: "open",
  priority: 1,
  issue_type: "bug",
  owner: null,
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  project_id: "gitboard",
  dependencies: [],
  related_ids: [],
  labels: [],
};

describe("IssueFeed row identity", () => {
  it("keys issue rows by immutable bead id, not refresh order or updated_at", () => {
    const first: FeedItem = { kind: "issue", issue: baseIssue, depth: 0, childCount: 0, relation: "parent" };
    const refreshed: FeedItem = { ...first, issue: { ...baseIssue, updated_at: "2026-01-01T00:01:00.000Z", status: "in_progress" } };

    expect(getFeedItemKey(first)).toBe("issue:forge-1");
    expect(getFeedItemKey(refreshed)).toBe(getFeedItemKey(first));
  });

  it("uses semantic keys for non-issue rows", () => {
    expect(getFeedItemKey({ kind: "open-header", count: 1, readyCount: 1 })).toBe("open-header");
    expect(getFeedItemKey({ kind: "in-progress-empty" })).toBe("in-progress-empty");
  });
});
