import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createXtrmDatabase } from "../../../../../packages/core/src/state/database.ts";
import {
  insertCommit,
  insertEvent,
  upsertIssue,
  upsertPr,
  upsertRelease,
  upsertRepo,
} from "../../../../../packages/core/src/github/index.ts";
import { createGithubRouter } from "../../../src/server/routes/github.ts";

describe("Console GitHub routes", () => {
  let root: string;
  let db: ReturnType<typeof createXtrmDatabase>;
  const originalAdminToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;

  beforeEach(() => {
    process.env.CONSOLE_WRITE_ADMIN_TOKEN = "github-secret";
    root = mkdtempSync(join(tmpdir(), "console-github-route-"));
    db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    upsertRepo(db, repo("owner/repo"));
    insertEvent(db, event("event-1"));
    insertCommit(db, commit("sha-1"));
    upsertPr(db, {
      repo: "owner/repo", number: 1, title: "PR", body: "body", state: "open", author: "alice",
      url: "https://github.com/owner/repo/pull/1", additions: 1, deletions: 2, changed_files: 3,
      comment_count: 0, label_names: null, created_at: "2026-07-22T10:00:00Z", updated_at: "2026-07-22T11:00:00Z",
      merged_at: null, closed_at: null,
    });
    upsertIssue(db, {
      repo: "owner/repo", number: 2, title: "Issue", body: "body", state: "open", author: "alice",
      url: "https://github.com/owner/repo/issues/2", comment_count: 0, label_names: null,
      created_at: "2026-07-22T10:00:00Z", updated_at: "2026-07-22T11:00:00Z", closed_at: null,
    });
    upsertRelease(db, {
      id: "release-1", tag_name: "v1", name: "v1", body: "notes", html_url: "https://github.com/owner/repo/releases/v1",
      author_login: "alice", published_at: "2026-07-22T12:00:00Z", repo_full_name: "owner/repo",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (originalAdminToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
    else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalAdminToken;
  });

  it("keeps the current read methods, envelopes, pagination, and 404s", async () => {
    const app = createGithubRouter(db);
    const responses = await Promise.all([
      app.request("http://localhost/events?limit=1&offset=0"),
      app.request("http://localhost/events/event-1"),
      app.request("http://localhost/events/missing"),
      app.request("http://localhost/commits?limit=1&offset=0"),
      app.request("http://localhost/commits/sha-1"),
      app.request("http://localhost/commits/missing"),
      app.request("http://localhost/repos"),
      app.request("http://localhost/repos/stats"),
      app.request("http://localhost/contributions?weeks=1"),
      app.request("http://localhost/summary?period=week"),
      app.request("http://localhost/prs?limit=1&offset=0"),
      app.request("http://localhost/prs/owner/repo/1"),
      app.request("http://localhost/prs/missing/repo/1"),
      app.request("http://localhost/issues?limit=1&offset=0"),
      app.request("http://localhost/issues/owner/repo/2"),
      app.request("http://localhost/issues/missing/repo/2"),
      app.request("http://localhost/releases?repo=owner/repo&limit=1&offset=0"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 404, 200, 200, 404, 200, 200, 200, 200, 200, 200, 404, 200, 200, 404, 200,
    ]);
    expect(await responses[0].json()).toMatchObject({ limit: 1, offset: 0, data: [{ id: "event-1" }] });
    expect(await responses[3].json()).toMatchObject({ limit: 1, offset: 0, data: [{ sha: "sha-1" }] });
    expect(await responses[16].json()).toMatchObject({ releases: [{ tag_name: "v1" }] });
  });

  it("accepts the legacy publisher slot and optional structured logger", async () => {
    const logger = { emit: vi.fn() };
    const publisher = { publish: vi.fn() };
    const response = await createGithubRouter(db, publisher, logger).request("http://localhost/events");

    expect(response.status).toBe(200);
    expect(logger.emit).toHaveBeenCalledWith(expect.objectContaining({ component: "api", event: "github.events.timing" }));
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("persists repository writes in Console-owned durable state", async () => {
    const app = createGithubRouter(db);
    const created = await app.request("http://localhost/repos", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "x-xtrm-peer-address": "127.0.0.1" },
      body: JSON.stringify({ full_name: "owner/new-repo", display_name: "New repo" }),
    });

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ full_name: "owner/new-repo", tracked: 1 });
    db.close();
    db = createXtrmDatabase(join(root, "xtrm.sqlite"));

    const persisted = await createGithubRouter(db).request("http://localhost/repos");
    const persistedBody = await persisted.json() as { data: Array<{ full_name: string }> };
    expect(persistedBody.data.some((repo) => repo.full_name === "owner/new-repo")).toBe(true);
  });

  it("preserves repository update and soft-delete semantics", async () => {
    const app = createGithubRouter(db);
    const update = await app.request("http://localhost/repos/owner%2Frepo", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "localhost", "x-console-write-token": "github-secret", "x-xtrm-peer-address": "127.0.0.1" },
      body: JSON.stringify({ display_name: "Updated", color: "#fff" }),
    });
    const deleted = await app.request("http://localhost/repos/owner%2Frepo", {
      method: "DELETE",
      headers: { host: "localhost", origin: "http://localhost", "x-xtrm-peer-address": "::1" },
    });

    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ display_name: "Updated", color: "#fff" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: "owner/repo" });
    expect(db.query("SELECT tracked FROM github_repos WHERE full_name = 'owner/repo'").get()).toEqual({ tracked: 0 });
  });

  it("rejects hostile origin, missing proof, and non-loopback peer writes", async () => {
    const app = createGithubRouter(db);
    const requests = [
      app.request("http://localhost/repos", {
        method: "POST",
        headers: { host: "localhost", origin: "https://attacker.example", "x-xtrm-peer-address": "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ full_name: "owner/hostile" }),
      }),
      app.request("http://localhost/repos/owner%2Frepo", { method: "PUT", headers: { host: "localhost", "x-xtrm-peer-address": "127.0.0.1", "content-type": "application/json" }, body: "{}" }),
      app.request("http://localhost/repos/owner%2Frepo", { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", "x-xtrm-peer-address": "10.0.0.7" } }),
    ];

    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([403, 403, 403]);
    expect(db.query("SELECT COUNT(*) AS count FROM github_repos WHERE full_name = 'owner/hostile'").get()).toEqual({ count: 0 });
  });

  it("keeps markdown and report route validation before network access", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
    const app = createGithubRouter(db);

    const markdown = await app.request("http://localhost/repo/owner/repo/markdown?path=package.json");
    const report = await app.request("http://localhost/repo/owner/repo/reports/bad.txt");
    const unknown = await app.request("http://localhost/repo/unknown/repo/reports");

    expect(markdown.status).toBe(400);
    expect(report.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains complete PR detail caching", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
    const app = createGithubRouter(db);

    const first = await app.request("http://localhost/prs/owner/repo/1/detail");
    const second = await app.request("http://localhost/prs/owner/repo/1/detail");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

function repo(full_name: string) {
  return { full_name, display_name: full_name, tracked: true, group_name: null, last_polled_at: null, color: null };
}

function event(id: string) {
  return {
    id, type: "PushEvent", repo: "owner/repo", branch: "main", actor: "alice", action: null,
    title: "commit", body: null, url: "https://github.com/owner/repo", additions: 1, deletions: 0,
    changed_files: 1, commit_count: 1, created_at: "2026-07-22T10:00:00Z",
  };
}

function commit(sha: string) {
  return {
    sha, repo: "owner/repo", branch: "main", author: "alice", message: "commit", url: "https://github.com/owner/repo/commit/sha-1",
    additions: null, deletions: null, changed_files: null, event_id: "event-1", committed_at: "2026-07-22T10:00:00Z",
  };
}
