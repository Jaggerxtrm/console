import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "../../../src/server/routes/github.ts";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { upsertPr, upsertRepo } from "../../../../../packages/core/src/github/index.ts";
import { clearReadmeCache } from "../../../../../packages/core/src/github/index.ts";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitboard-github-detail-"));
  db = createDatabase(join(dir, "state.db"));
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITBOARD_PR_DETAIL_SECTION_TIMEOUT_MS = "20";
  clearReadmeCache();
  upsertRepo(db, {
    full_name: "owner/repo",
    display_name: "owner/repo",
    tracked: true,
    group_name: null,
    last_polled_at: null,
    color: null,
  });
  upsertPr(db, {
    repo: "owner/repo",
    number: 1,
    title: "Test PR",
    body: "body",
    state: "open",
    author: "alice",
    url: "https://github.com/owner/repo/pull/1",
    additions: 1,
    deletions: 1,
    changed_files: 1,
    comment_count: 1,
    label_names: null,
    created_at: "2026-05-20T10:00:00Z",
    updated_at: "2026-05-20T11:00:00Z",
    merged_at: null,
    closed_at: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearReadmeCache();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITBOARD_PR_DETAIL_SECTION_TIMEOUT_MS;
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function routerRequest(path: string): Promise<Response> {
  const app = createGithubRouter(db);
  return Promise.resolve(app.request(path));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function abortingNever(signal?: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

describe("GitHub PR detail route", () => {
  it("returns partial detail with section errors when one GitHub segment times out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/issues/1/comments")) return abortingNever(init?.signal ?? undefined);
      if (url.includes("/pulls/1/reviews")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/pulls/1/comments")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/pulls/1/commits")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/pulls/1/files")) return Promise.resolve(jsonResponse([]));
      if (url.includes("/issues/1/timeline")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse([]));
    });

    const res = await routerRequest("/prs/owner/repo/1/detail");
    const body = await res.json() as { comments: unknown[]; errors: Record<string, string> };

    expect(res.status).toBe(200);
    expect(body.comments).toEqual([]);
    expect(body.errors.comments).toContain("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("caches complete PR detail responses by PR updated timestamp", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(jsonResponse([])));

    await routerRequest("/prs/owner/repo/1/detail");
    await routerRequest("/prs/owner/repo/1/detail");

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("GitHub markdown route", () => {
  it("accepts README and rejects arbitrary files without outbound fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ content: "readme", sha: "sha", last_modified: null }));

    const ok = await routerRequest("/repo/owner/repo/markdown?path=README.md");
    const okBody = await ok.json() as { content: string; sha: string; last_modified: string | null };
    const bad = await routerRequest("/repo/owner/repo/markdown?path=package.json");
    const badBody = await bad.json() as { error: string };

    expect(ok.status).toBe(200);
    expect(okBody.content).toBe("readme");
    expect(bad.status).toBe(400);
    expect(badBody.error).toBe("invalid path");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown repos before fetching markdown", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ content: "private", sha: "sha", last_modified: null }));

    const res = await routerRequest("/repo/unknown/private/markdown?path=README.md");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub reports route", () => {
  it("lists report entries without fetching every report body for frontmatter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([
      { name: "2026-05-20.md", path: ".xtrm/reports/2026-05-20.md", sha: "sha-1", size: 123, type: "file" },
      { name: "ignore.txt", path: ".xtrm/reports/ignore.txt", sha: "sha-2", size: 10, type: "file" },
    ]));

    const res = await routerRequest("/repo/owner/repo/reports");
    const body = await res.json() as { data: Array<{ name: string; frontmatter: Record<string, string> | null }> };

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ name: "2026-05-20.md", path: ".xtrm/reports/2026-05-20.md", sha: "sha-1", size: 123, frontmatter: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown repos before listing reports", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const res = await routerRequest("/repo/unknown/private/reports");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown repos before fetching report details", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ content: "private", sha: "sha", last_modified: null }));

    const res = await routerRequest("/repo/unknown/private/reports/2026-05-20.md");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
