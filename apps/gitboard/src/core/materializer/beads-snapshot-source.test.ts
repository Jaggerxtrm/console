import { afterEach, describe, expect, it } from "vitest";
import { subscribe } from "../logger.ts";
import { BeadsSnapshotSource } from "./beads-snapshot-source.ts";
import type { BeadIssue } from "../../types/beads.ts";

function makeIssue(id: string): BeadIssue {
  return {
    id,
    title: id,
    description: null,
    notes: null,
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    closed_at: undefined,
    close_reason: undefined,
    project_id: "",
    dependencies: [],
    parent_id: undefined,
    related_ids: [],
    labels: [],
  };
}

describe("BeadsSnapshotSource", () => {
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it("pages dolt reads until short page and logs progress", async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, index) => makeIssue(`issue-${index}`)),
      Array.from({ length: 3 }, (_, index) => makeIssue(`issue-${1000 + index}`)),
    ];
    const calls: Array<{ limit?: number; offset?: number }> = [];
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const doltClient = {
      async getIssues(filters: { limit?: number; offset?: number }): Promise<BeadIssue[]> {
        calls.push(filters);
        return pages[calls.length - 1] ?? [];
      },
    };
    unsubscribe = subscribe({ component: "system", event: "beads-snapshot" }, (entry) => {
      events.push({ event: entry.event, data: entry.data });
    });
    const source = new BeadsSnapshotSource({ sourceKey: "repo-1", beadsPath: "/tmp/beads", doltClient });

    const rows = await source.readSnapshot();

    expect(rows).toHaveLength(1003);
    expect(calls).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
    ]);
    expect(events).toHaveLength(3);
    expect(events[0]?.data).toMatchObject({ repo_slug: "repo-1", page: 1, offset: 0, got: 1000 });
    expect(events[1]?.data).toMatchObject({ repo_slug: "repo-1", page: 2, offset: 1000, got: 3 });
    expect(events[2]?.data).toMatchObject({ repo_slug: "repo-1", total_pages: 2, total_issues: 1003 });
    expect(events[0]?.event).toBe("beads-snapshot");
  });

  it("stops at safety cap", async () => {
    const calls: Array<{ limit?: number; offset?: number }> = [];
    const events: Array<{ event: string; level: string; data?: Record<string, unknown> }> = [];
    const doltClient = {
      async getIssues(filters: { limit?: number; offset?: number }): Promise<BeadIssue[]> {
        calls.push(filters);
        return Array.from({ length: 1000 }, (_, index) => makeIssue(`issue-${filters.offset ?? 0}-${index}`));
      },
    };
    unsubscribe = subscribe({ component: "system" }, (entry) => {
      if (entry.event === "beads-snapshot") {
        events.push({ event: entry.event, level: entry.level, data: entry.data });
      }
    });
    const source = new BeadsSnapshotSource({ sourceKey: "repo-2", beadsPath: "/tmp/beads", doltClient });

    const rows = await source.readSnapshot();

    expect(rows).toHaveLength(10000);
    expect(calls).toHaveLength(10);
    expect(events.at(-1)).toMatchObject({ event: "beads-snapshot", level: "warn", data: { repo_slug: "repo-2", at_offset: 10000 } });
  });
});
