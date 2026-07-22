import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun", () => ({ serve: vi.fn() }));

import { createHtmlPreviewApp } from "./server.ts";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("html preview Hono app compatibility", () => {
  it("serves indexed repository data through the upgraded Hono runtime", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "html-preview-hono-"));
    const repo = join(tempRoot, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "README.md"), "# Preview docs\n");

    const app = createHtmlPreviewApp({
      root: tempRoot,
      roots: [tempRoot],
      port: 0,
      host: "127.0.0.1",
      maxDepth: 2,
      maxFiles: 10,
    });

    const response = await app.request("http://localhost/api/index");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repos: [expect.objectContaining({ name: "repo" })],
      documents: [expect.objectContaining({ path: "README.md", title: "Preview docs" })],
    });
  });
});
