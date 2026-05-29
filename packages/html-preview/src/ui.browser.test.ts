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

    await expectVisibleRows(page, 5);
    await expect.poll(() => page.locator(".folder-filter:visible").count()).toBe(0);
    expect(await page.locator(".html-row").first().textContent()).toContain("/tmp/repos/alpha/docs/index.md");

    await page.locator('.repo-filter[data-repo="alpha"]').click();
    await expectVisibleRows(page, 4);
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(3);
    expect(await page.locator("#result-count").textContent()).toBe("4 visible");

    const folderLabels = await page.locator('.folder-filter[data-repo="alpha"]:visible .folder-filter-label').allTextContents();
    expect(folderLabels).toContain(".xtrm");
    expect(folderLabels).not.toContain("skills");
    expect(folderLabels).not.toContain(".xtrm/skills/default/clean-code");

    await page.locator('.folder-filter[data-repo="alpha"][data-folder=".xtrm"]').click();
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(4);
    await page.locator('.folder-filter[data-repo="alpha"][data-folder=".xtrm/skills"]').click();
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(5);
    await page.locator('.folder-filter[data-repo="alpha"][data-folder=".xtrm/skills/default"]').click();
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(7);
    await expectVisibleRows(page, 2);

    await page.locator('.folder-filter[data-repo="alpha"][data-folder=".xtrm/skills/default"]').click();
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(5);

    await page.locator('.folder-filter[data-repo="alpha"][data-folder="coverage"]').click();
    await expectVisibleRows(page, 1);
    expect(await page.locator("#result-count").textContent()).toBe("1 visible");

    await page.locator('.repo-filter[data-repo="alpha"]').click();
    await expectVisibleRows(page, 4);
    await page.locator('.repo-filter[data-repo="alpha"]').click();
    await expect.poll(() => page.locator('.folder-filter[data-repo="alpha"]:visible').count()).toBe(0);

    await page.locator("#search").fill("coverage");
    await expectVisibleRows(page, 1);
    expect(await page.locator("#result-count").textContent()).toBe("1 visible");

    await page.locator("#search").fill("no-match");
    await expectVisibleRows(page, 0);
    expect(await page.locator("#result-count").textContent()).toBe("0 visible");
    await expect.poll(() => page.locator("#filtered-empty:visible").count()).toBe(1);

    await page.locator(".ide-theme-toggle").click();
    const lightThemeColors = await page.evaluate(() => {
      const background = (selector: string) => getComputedStyle(document.querySelector(selector) as Element).backgroundColor;
      return {
        topbar: background(".ide-topbar"),
        sidebar: background(".ide-sidebar"),
        main: background(".ide-main"),
      };
    });
    expect(lightThemeColors).toEqual({
      topbar: "rgb(255, 255, 255)",
      sidebar: "rgb(255, 255, 255)",
      main: "rgb(255, 255, 255)",
    });

    await page.close();
  });

  it("keeps large indexes windowed instead of rendering every row and folder upfront", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
    const index = makeLargeIndex(600);
    await page.setContent(renderIndex(index), { waitUntil: "load" });

    await expect.poll(() => page.locator(".html-row").count()).toBeLessThan(180);
    await expect.poll(() => page.locator(".folder-node").count()).toBe(0);
    expect(await page.locator("#result-count").textContent()).toBe("600 visible");

    await page.locator('.repo-filter[data-repo="alpha"]').click();
    await expect.poll(() => page.locator(".html-row").count()).toBeLessThan(180);
    await expect.poll(() => page.locator(".folder-node").count()).toBeGreaterThan(0);
    expect(await page.locator("#result-count").textContent()).toBe("600 visible");

    await page.close();
  });

});

async function expectVisibleRows(page: Page, expected: number): Promise<void> {
  await expect.poll(() => page.locator(".html-row:visible").count()).toBe(expected);
}

function makeIndex(): PreviewIndex {
  return {
    root: "/tmp/repos",
    roots: ["/tmp/repos"],
    generatedAt: "2026-05-27T00:00:00.000Z",
    repos: [
      { id: "alpha", name: "alpha", root: "/tmp/repos", path: "/tmp/repos/alpha", absolutePath: "/tmp/repos/alpha", relativePath: "alpha" },
      { id: "beta", name: "beta", root: "/tmp/repos", path: "/tmp/repos/beta", absolutePath: "/tmp/repos/beta", relativePath: "beta" },
    ],
    documents: [
      makeDocument("alpha", "alpha", "docs/index.md", "Docs", "markdown"),
      makeDocument("alpha", "alpha", "coverage/index.html", "Coverage", "html"),
      makeDocument("alpha", "alpha", ".xtrm/skills/default/clean-code/SKILL.md", "Clean Code", "markdown"),
      makeDocument("alpha", "alpha", ".xtrm/skills/default/find-docs/SKILL.md", "Find Docs", "markdown"),
      makeDocument("beta", "beta", "site/index.html", "Website"),
    ],
  };
}

function makeDocument(repoId: string, repoName: string, path: string, title: string, kind: "html" | "markdown" | "text" = "html") {
  const absolutePath = `/tmp/repos/${repoName}/${path}`;
  return {
    id: `${repoId}:${path}`,
    repoId,
    repoName,
    repoPath: `/tmp/repos/${repoName}`,
    absolutePath,
    path,
    displayPath: absolutePath,
    kind,
    title,
    size: 100,
    modifiedAt: "2026-05-27T00:00:00.000Z",
    folderPath: path.includes("/") ? path.split("/").slice(0, -1).join("/") : ".",
    proximity: path.split("/").length - 1,
  };
}


function makeLargeIndex(count: number): PreviewIndex {
  return {
    root: "/tmp/repos",
    roots: ["/tmp/repos"],
    generatedAt: "2026-05-27T00:00:00.000Z",
    repos: [
      { id: "alpha", name: "alpha", root: "/tmp/repos", path: "/tmp/repos/alpha", absolutePath: "/tmp/repos/alpha", relativePath: "alpha" },
    ],
    documents: Array.from({ length: count }, (_, index) => makeDocument(
      "alpha",
      "alpha",
      `docs/section-${Math.floor(index / 25)}/doc-${index}.md`,
      `Doc ${index}`,
      "markdown",
    )),
  };
}
