import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";
import { getRepoPollState } from "../../../../packages/core/src/github/index.ts";
import {
  GithubPoller,
  transformCommits,
  transformEvent,
} from "../../src/server/github/poller.ts";

describe("Console GitHub poller ownership", () => {
  let root: string;
  let db: ReturnType<typeof createXtrmDatabase>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "console-github-poller-"));
    db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    db.query("INSERT INTO github_repos (full_name, display_name, tracked) VALUES (?, ?, 1)").run("owner/repo", "repo");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the shared event and commit transformations", () => {
    const raw = {
      id: "event-1", type: "PushEvent", repo: { name: "owner/repo" }, actor: { login: "alice" },
      created_at: "2026-07-22T10:00:00Z", payload: {
        ref: "refs/heads/main", size: 1,
        commits: [{ sha: "sha-1", message: "commit", author: { name: "alice" }, url: "https://api.github.com/repos/owner/repo/commits/sha-1" }],
      },
    };

    expect(transformEvent(raw).branch).toBe("main");
    expect(transformEvent(raw).commit_count).toBe(1);
    expect(transformCommits(raw)[0]).toMatchObject({ sha: "sha-1", event_id: "event-1", branch: "main" });
  });

  it("persists poll freshness and endpoint ETags across poller instances", async () => {
    const requestHeaders: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      if (requestHeaders.length <= 3) {
        const etags = ['"issues-v1"', '"pulls-v1"', '"releases-v1"'];
        return new Response("[]", { status: 200, headers: { ETag: etags[requestHeaders.length - 1] } });
      }
      return new Response(null, { status: 304 });
    });

    await new GithubPoller(db, "token").pollRepos();
    const state = getRepoPollState(db, "owner/repo");
    expect(state.issue_etag).toBe('"issues-v1"');
    expect(state.pr_etag).toBe('"pulls-v1"');
    expect(state.release_etag).toBe('"releases-v1"');
    expect(db.query("SELECT last_polled_at FROM github_repos WHERE full_name = 'owner/repo'").get()).toMatchObject({ last_polled_at: expect.any(String) });

    db.query("UPDATE github_repos SET last_polled_at = '2020-01-01T00:00:00Z' WHERE full_name = 'owner/repo'").run();
    await new GithubPoller(db, "token").pollRepos();

    expect(requestHeaders.slice(3).map((headers) => headers.get("If-None-Match"))).toEqual(['"issues-v1"', '"pulls-v1"', '"releases-v1"']);
  });
});
