import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../../src/core/store.ts";
import { insertEvent } from "../../../src/core/github-store.ts";
import { createApp } from "../../../src/api/server.ts";
import type { Database } from "bun:sqlite";
import type { GithubEvent } from "../../../src/core/github-store.ts";

let dir: string;
let db: Database;

const releaseEvent: GithubEvent = {
  id: "r1",
  type: "ReleaseEvent",
  repo: "owner/repo-a",
  branch: null,
  actor: "alice",
  action: "published",
  title: "v1.2.3",
  body: "Release notes",
  url: "https://github.com/owner/repo-a/releases/tag/v1.2.3",
  additions: null,
  deletions: null,
  changed_files: null,
  commit_count: null,
  created_at: "2026-03-06T10:00:00Z",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "af-releases-test-"));
  db = createDatabase(join(dir, "state.db"));
  insertEvent(db, releaseEvent);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true });
});

async function req(path: string): Promise<Response> {
  const { app } = createApp(db);
  return app.fetch(new Request(`http://localhost${path}`));
}

describe("GET /api/github/releases", () => {
  it("returns releases for repo", async () => {
    const res = await req("/api/github/releases?repo=owner/repo-a");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.releases).toHaveLength(1);
    expect(json.releases[0].tag_name).toBe("v1.2.3");
  });

  it("returns 400 without repo", async () => {
    const res = await req("/api/github/releases");
    expect(res.status).toBe(400);
  });
});
