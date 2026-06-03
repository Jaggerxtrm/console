#!/usr/bin/env node

const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.GITBOARD_E2E_URL ?? "http://100.113.49.52:3030/gitboard/";
const shotDir = join(process.cwd(), "test-results/live-specialists");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(shotDir, name), fullPage: true });
}

async function selected(locator) {
  return (await locator.getAttribute("aria-selected")) === "true";
}

async function selectGitboardRepo(page) {
  const rows = page.locator(".ide-repo-row");
  await rows.first().waitFor({ state: "visible", timeout: 10_000 });
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const title = (await row.getAttribute("title")) ?? "";
    const text = await row.innerText();
    if (`${title}\n${text}`.toLowerCase().includes("gitboard")) {
      await row.click();
      return { title, text: text.replace(/\s+/g, " ").trim() };
    }
  }
  throw new Error("Could not find a gitboard repo row in the sidebar");
}

async function main() {
  mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    if (errorText.includes("net::ERR_ABORTED")) return;
    failedRequests.push(`${request.method()} ${request.url()} ${errorText}`);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    const github = page.getByRole("tab", { name: "GitHub" });
    const consoleTab = page.getByRole("tab", { name: "Console" });
    await github.waitFor({ state: "visible", timeout: 10_000 });
    await github.click();
    assert(await selected(github), "GitHub tab did not stay selected after click");
    await screenshot(page, "01-github-selected.png");

    await consoleTab.click();
    assert(await selected(consoleTab), "Console tab did not stay selected after click");
    await screenshot(page, "02-console-selected.png");

    const repo = await selectGitboardRepo(page);
    await page.getByRole("tab", { name: "Specialists" }).click();
    await page.getByText("Specialist cockpit").waitFor({ state: "visible", timeout: 10_000 });
    await screenshot(page, "03-specialists-all.png");

    await page.getByRole("button", { name: /^Waiting\b/ }).click();
    await page.locator(".console-specialists-card").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("Bead contract").first().waitFor({ state: "visible", timeout: 10_000 });
    await waitForContractSettled(page);
    await screenshot(page, "03b-specialists-waiting-contract-collapsed.png");

    await page.getByRole("button", { name: /^Done\b/ }).click();
    const firstCard = page.locator(".console-specialists-card").first();
    await firstCard.waitFor({ state: "visible", timeout: 10_000 });
    await waitForContractSettled(page);
    await screenshot(page, "04-specialists-done-filter.png");
    await page.getByText("Bead contract").first().click();
    await page.locator(".console-specialists-contract-markdown, .console-specialists-contract-empty").first().waitFor({ state: "visible", timeout: 10_000 });
    await screenshot(page, "04b-bead-contract-expanded.png");
    await page.getByText("Bead contract").first().click();

    await firstCard.click();
    const feedToggle = page.getByRole("button", { name: /terminal feed/i }).first();
    await feedToggle.waitFor({ state: "visible", timeout: 10_000 });
    assert((await feedToggle.getAttribute("aria-expanded")) === "false", "Done job feed was not initially collapsed");
    const resultToggle = page.getByRole("button", { name: /run result/i }).first();
    await resultToggle.waitFor({ state: "visible", timeout: 10_000 });
    assert((await resultToggle.getAttribute("aria-expanded")) === "false", "Done job result was not initially collapsed");
    await screenshot(page, "05-terminal-feed-collapsed.png");

    await resultToggle.click();
    assert((await resultToggle.getAttribute("aria-expanded")) === "true", "Run result did not expand after click");
    await page.locator(".console-specialists-job-result-body").first().waitFor({ state: "visible", timeout: 10_000 });
    await screenshot(page, "05b-run-result-expanded.png");

    await feedToggle.click();
    assert((await feedToggle.getAttribute("aria-expanded")) === "true", "Terminal feed did not expand after click");
    await page.locator(".console-specialists-job-terminal").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".console-specialists-job-terminal-text").first().waitFor({ state: "visible", timeout: 10_000 });
    await screenshot(page, "06-terminal-feed-expanded.png");

    const terminalText = await page.locator(".console-specialists-job-terminal-text").first().innerText();
    assert(terminalText.trim().length > 0, "Expanded terminal feed rendered empty text");
    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      selectedRepo: repo,
      screenshots: shotDir,
      terminalPreview: terminalText.replace(/\s+/g, " ").trim().slice(0, 160),
      pageErrors,
      failedRequests,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

async function waitForContractSettled(page) {
  await page.waitForFunction(() => {
    const contract = document.querySelector(".console-specialists-contract");
    return contract && !contract.textContent?.includes("loading");
  }, null, { timeout: 10_000 }).catch(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
