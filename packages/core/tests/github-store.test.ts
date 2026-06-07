import { describe, expect, it } from "vitest";
import {
  ensureRepo,
  getEvents,
  getRepoPollState,
  getRepoStats,
  insertEvent,
  isTruncated,
  upsertRepo,
  type RepoStat,
} from "../src/github/index.ts";

describe("core github store exports", () => {
  it("exports the durable GitHub store contract", () => {
    expect(insertEvent).toEqual(expect.any(Function));
    expect(getEvents).toEqual(expect.any(Function));
    expect(ensureRepo).toEqual(expect.any(Function));
    expect(upsertRepo).toEqual(expect.any(Function));
    expect(getRepoPollState).toEqual(expect.any(Function));
    expect(getRepoStats).toEqual(expect.any(Function));
    expect(isTruncated("a".repeat(70))).toBe(true);
  });

  it("exposes the repo stats DTO shape for app wrappers", () => {
    const stat = {
      full_name: "owner/repo",
      pushes: 1,
      prs_open: 0,
      prs_closed: 0,
      issues_open: 0,
      releases: 0,
      last_event_at: null,
    } satisfies RepoStat;

    expect(stat.full_name).toBe("owner/repo");
  });
});
