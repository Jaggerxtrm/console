import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { upsertRelease } from "../../../../../packages/core/src/github/index.ts";
import { createApp } from "../../../src/api/server.ts";
import type { Database } from "bun:sqlite";
let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "af-releases-test-"));
  db = createDatabase(join(dir, "state.db"));
  upsertRelease(db, {
    id: "r1",
    tag_name: "v1.2.3",
    name: "v1.2.3",
    body: "Release notes",
    html_url: "https://github.com/owner/repo-a/releases/tag/v1.2.3",
    author_login: "alice",
    published_at: "2026-03-06T10:00:00Z",
    repo_full_name: "owner/repo-a",
  });
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

  it("returns releases without a repo filter", async () => {
    const res = await req("/api/github/releases");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.releases).toHaveLength(1);
  });
});
