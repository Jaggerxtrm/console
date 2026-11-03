import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { createGithubRouter } from "../../../src/server/routes/github.ts";
import { createDatabase } from "../../../../../packages/core/src/github/database.ts";
import { createGithubAuthService, upsertRepo, type StoredUserToken, type TokenStore } from "../../../../../packages/core/src/github/index.ts";

/**
 * SVG diagrams embedded in PR and issue bodies. pr-lens writes them to a `pr-lens` branch and links
 * `github.com/<repo>/raw/<ref>/<path>`; the browser cannot fetch those (SameSite=Lax cookies are not
 * sent on a cross-site <img>), so the console proxies the bytes with its own token.
 */

let dir: string;
let db: Database;
let fetchLog: string[];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-raw-svg-"));
  db = createDatabase(join(dir, "state.db"));
  process.env.GITHUB_TOKEN = "test-token";
  process.env.XTRM_GITHUB_API_BASE_URL = "https://api.fake";
  fetchLog = [];
  upsertRepo(db, { full_name: "owner/repo", display_name: null, tracked: true, group_name: null, last_polled_at: null, color: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.XTRM_GITHUB_API_BASE_URL;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRouter(): ReturnType<typeof createGithubRouter> {
  let record: StoredUserToken | null = null;
  const store: TokenStore = {
    kind: "file",
    async get() { return record; },
    async set(next) { record = next; },
    async delete() { record = null; },
  };
  return createGithubRouter(db, undefined, undefined, {
    auth: createGithubAuthService({ env: {}, store, registerTokenProvider: false }),
  });
}

function mockContents(body: unknown, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = String(input);
    fetchLog.push(url);
    if (url.includes("/contents/")) {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const contentsEntry = (content: string) => ({ content: Buffer.from(content).toString("base64"), encoding: "base64", sha: "abc123" });

describe("GET /api/github/repo/:owner/:name/raw-svg", () => {
  it("serves the SVG from the named ref with an image content type and the upstream sha as etag", async () => {
    mockContents(contentsEntry(SVG));
    const response = await makeRouter().request("http://localhost/repo/owner/repo/raw-svg?path=pr/1/diagram-light.svg&ref=pr-lens");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await response.text()).toBe(SVG);
    expect(fetchLog[0]).toContain("/contents/pr%2F1%2Fdiagram-light.svg");
    expect(fetchLog[0]).toContain("ref=pr-lens");
  });

  it("refuses a path that is not an SVG, absolute, or traversing", async () => {
    mockContents(contentsEntry(SVG));
    const app = makeRouter();
    for (const path of ["package.json", "/etc/passwd.svg", "../secret.svg", "a/../../b.svg", "diagram.svg\\x"]) {
      const response = await app.request(`http://localhost/repo/owner/repo/raw-svg?path=${encodeURIComponent(path)}&ref=main`);
      expect(response.status, path).toBe(400);
    }
    expect(fetchLog).toHaveLength(0);
  });

  it("answers 404 for a repository the console does not track", async () => {
    mockContents(contentsEntry(SVG));
    const response = await makeRouter().request("http://localhost/repo/other/repo/raw-svg?path=diagram.svg&ref=main");
    expect(response.status).toBe(404);
    expect(fetchLog).toHaveLength(0);
  });

  it("answers 404 when GitHub has no such file on that ref", async () => {
    mockContents({ message: "Not Found" }, 404);
    const response = await makeRouter().request("http://localhost/repo/owner/repo/raw-svg?path=pr/1/missing.svg&ref=pr-lens");
    expect(response.status).toBe(404);
  });

  it("answers 413 for an asset past the size ceiling", async () => {
    mockContents(contentsEntry(`<svg>${"x".repeat(1_000_001)}</svg>`));
    const response = await makeRouter().request("http://localhost/repo/owner/repo/raw-svg?path=huge.svg&ref=main");
    expect(response.status).toBe(413);
  });

  it("answers 502 when the GitHub call fails", async () => {
    mockContents({ message: "boom" }, 500);
    const response = await makeRouter().request("http://localhost/repo/owner/repo/raw-svg?path=diagram.svg&ref=main");
    expect(response.status).toBe(502);
  });
});
