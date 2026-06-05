const { test, expect } = require("playwright/test");

test("specialists feed and graph render live dependencies", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://100.113.49.52:3030/gitboard/console/feed", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "specialists", exact: true }).click();
  await expect(page.getByText("Pick a project")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /open:71, ready:65/ })).toBeVisible();
  await expect(page.getByText(/discovered from:/).first()).toBeVisible();
  await expect(page.getByText(/related:/).first()).toBeVisible();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "test-results/live-specialists/specialists-feed-clicked.png", fullPage: true });

  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.getByText("No beads in this project")).toHaveCount(0);
  await expect(page.getByText(/2501 nodes · 2096 edges/)).toBeVisible();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "test-results/live-specialists/specialists-graph-clicked.png", fullPage: true });
});
