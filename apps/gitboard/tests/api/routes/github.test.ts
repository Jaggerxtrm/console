import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { insertEvent, insertCommit, upsertRepo } from "../../../../../packages/core/src/github/index.ts";
import { createApp } from "../../../src/api/server.ts";
import type { Database } from "bun:sqlite";
import type { GithubEvent, GithubCommit } from "../../../../../packages/core/src/github/index.ts";

let dir: string;
let db: Database;

const evt1: GithubEvent = {
  id: "e1",
  type: "PushEvent",
  repo: "owner/repo-a",
  branch: "main",
  actor: "alice",
  action: null,
  title: "fix: something",
  body: null,
  url: "https://github.com/owner/repo-a",
  additions: 20,
  deletions: 5,
  changed_files: 2,
  commit_count: 1,
  created_at: "2026-03-05T10:00:00Z",
};

const evt2: GithubEvent = {
  id: "e2",
  type: "PullRequestEvent",
  repo: "owner/repo-b",
  branch: null,
  actor: "bob",
  action: "opened",
  title: "feat: new feature",
  body: null,
  url: null,
  additions: null,
  deletions: null,
  changed_files: null,
  commit_count: null,
  created_at: "2026-03-06T10:00:00Z",
};

const commit1: GithubCommit = {
  sha: "abc123",
  repo: "owner/repo-a",
  branch: "main",
  author: "alice",
  message: "fix: something",
  url: "https://github.com/owner/repo-a/commit/abc123",
  additions: null,
  deletions: null,
  changed_files: null,
  event_id: "e1",
  committed_at: "2026-03-05T10:00:00Z",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "af-api-test-"));
  db = createDatabase(join(dir, "state.db"));
  insertEvent(db, evt1);
  insertEvent(db, evt2);
  insertCommit(db, commit1);
  upsertRepo(db, { full_name: "owner/repo-a", display_name: "Repo A", tracked: true, group_name: "g1", last_polled_at: null, color: "#ff0000" });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true });
});

async function req(path: string, method = "GET", body?: unknown): Promise<Response> {
  const { app } = createApp(db);
  const url = `http://localhost${path}`;
  const headers = new Headers({ host: "localhost", origin: "http://localhost" });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  return app.fetch(new Request(url, init));
}

describe("GET /api/github/events", () => {
  it("returns all events with pagination envelope", async () => {
    const res = await req("/api/github/events");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.limit).toBe(50);
    expect(json.offset).toBe(0);
  });

  it("filters by repos", async () => {
    const res = await req("/api/github/events?repos=owner/repo-a");
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].repo).toBe("owner/repo-a");
  });

  it("filters by types", async () => {
    const res = await req("/api/github/events?types=PullRequestEvent");
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].type).toBe("PullRequestEvent");
  });

  it("paginates with limit and offset", async () => {
    const res = await req("/api/github/events?limit=1&offset=0");
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.limit).toBe(1);
  });
});

describe("GET /api/github/events/:id", () => {
  it("returns single event", async () => {
    const res = await req("/api/github/events/e1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("e1");
  });

  it("returns 404 for unknown id", async () => {
    const res = await req("/api/github/events/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/github/commits", () => {
  it("returns commits", async () => {
    const res = await req("/api/github/commits");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].sha).toBe("abc123");
  });

  it("filters by repo", async () => {
    const res = await req("/api/github/commits?repo=owner/repo-a");
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });
});

describe("GET /api/github/commits/:sha", () => {
  it("returns single commit", async () => {
    const res = await req("/api/github/commits/abc123");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sha).toBe("abc123");
  });

  it("returns 404 for unknown sha", async () => {
    const res = await req("/api/github/commits/deadbeef");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/github/repos", () => {
  it("returns tracked repos", async () => {
    const res = await req("/api/github/repos");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].full_name).toBe("owner/repo-a");
  });
});

describe("POST /api/github/repos", () => {
  it("adds a new repo", async () => {
    const res = await req("/api/github/repos", "POST", { full_name: "owner/new-repo" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.full_name).toBe("owner/new-repo");
  });

  it("returns 400 when full_name missing", async () => {
    const res = await req("/api/github/repos", "POST", { color: "#abc" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/github/repos/:name", () => {
  it("updates repo fields", async () => {
    const res = await req("/api/github/repos/owner%2Frepo-a", "PUT", { color: "#00ff00", display_name: "Updated" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.color).toBe("#00ff00");
    expect(json.display_name).toBe("Updated");
  });

  it("returns 404 for unknown repo", async () => {
    const res = await req("/api/github/repos/owner%2Funknown", "PUT", { color: "#000" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/github/repos/:name", () => {
  it("sets tracked=false", async () => {
    const res = await req("/api/github/repos/owner%2Frepo-a", "DELETE");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted).toBe("owner/repo-a");
  });

  it("returns 404 for unknown repo", async () => {
    const res = await req("/api/github/repos/owner%2Funknown", "DELETE");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/github/contributions", () => {
  it("returns contribution data", async () => {
    const res = await req("/api/github/contributions");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
  });
});

describe("GET /api/github/summary", () => {
  it("returns summary stats", async () => {
    const res = await req("/api/github/summary");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("events");
    expect(json).toHaveProperty("pushes");
    expect(json).toHaveProperty("prs");
    expect(json).toHaveProperty("commits");
    expect(json).toHaveProperty("repos");
  });
});

describe("GET /api/github/repos/stats", () => {
  it("returns per-repo stats array", async () => {
    const res = await req("/api/github/repos/stats");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
  });

  it("each stat has full_name, pushes, prs_open, prs_closed", async () => {
    const res = await req("/api/github/repos/stats");
    const json = await res.json();
    // repo-a had a push event and is the only active repo in last 24h if we adjust dates
    // at minimum the shape must be correct for any entries returned
    json.data.forEach((s: Record<string, unknown>) => {
      expect(s).toHaveProperty("full_name");
      expect(s).toHaveProperty("pushes");
      expect(s).toHaveProperty("prs_open");
      expect(s).toHaveProperty("prs_closed");
    });
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });
});
