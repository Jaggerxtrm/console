import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderIndex } from "./ui.ts";
import type { Browser, Page } from "playwright";
import type { PreviewIndex } from "./types.ts";

describe("rendered index interactions", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("filters rows by repository and search term in a browser", async () => {
    const page = await browser.newPage();
    await page.setContent(renderIndex(makeIndex()), { waitUntil: "load" });

    await expectVisibleRows(page, 3);

    await page.locator('.repo-filter[data-repo="alpha"]').click();
    await expectVisibleRows(page, 2);
    expect(await page.locator("#result-count").textContent()).toBe("2 visible");

    await page.locator("#search").fill("coverage");
    await expectVisibleRows(page, 1);
    expect(await page.locator("#result-count").textContent()).toBe("1 visible");

    await page.locator("#search").fill("no-match");
    await expectVisibleRows(page, 0);
    expect(await page.locator("#result-count").textContent()).toBe("0 visible");
    await expect.poll(() => page.locator("#filtered-empty:visible").count()).toBe(1);

    await page.close();
  });
});

async function expectVisibleRows(page: Page, expected: number): Promise<void> {
  await expect.poll(() => page.locator(".html-row:visible").count()).toBe(expected);
}

function makeIndex(): PreviewIndex {
  return {
    root: "/tmp/repos",
    generatedAt: "2026-05-27T00:00:00.000Z",
    repos: [
      { id: "alpha", name: "alpha", path: "/tmp/repos/alpha", relativePath: "alpha" },
      { id: "beta", name: "beta", path: "/tmp/repos/beta", relativePath: "beta" },
    ],
    documents: [
      makeDocument("alpha", "alpha", "docs/index.html", "Docs"),
      makeDocument("alpha", "alpha", "coverage/index.html", "Coverage"),
      makeDocument("beta", "beta", "site/index.html", "Website"),
    ],
  };
}

function makeDocument(repoId: string, repoName: string, path: string, title: string) {
  return {
    id: `${repoId}:${path}`,
    repoId,
    repoName,
    repoPath: `/tmp/repos/${repoName}`,
    path,
    title,
    size: 100,
    modifiedAt: "2026-05-27T00:00:00.000Z",
  };
}
