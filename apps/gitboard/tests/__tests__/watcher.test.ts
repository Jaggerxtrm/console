import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservabilityWatcher } from "../../src/server/observability/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const triggerMaterializer = vi.hoisted(() => vi.fn());

vi.mock("../../src/api/server.ts", () => ({
  getCurrentMaterializer: () => ({ trigger: triggerMaterializer }),
}));

afterEach(() => {
  triggerMaterializer.mockReset();
  vi.restoreAllMocks();
});

describe("createObservabilityWatcher", () => {
  it("bumps epoch after db write", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-watch-"));
    const repoPath = join(root, "alpha");
    mkdirSync(repoPath, { recursive: true });
    const dbPath = join(repoPath, "observability.db");
    writeFileSync(dbPath, "seed");

    const watcher = createObservabilityWatcher([
      { repoSlug: "alpha", repoPath, dbPath, mtimeMs: 0 },
    ], { debounceMs: 10 });

    watcher.start();
    writeFileSync(dbPath, "next");

    await expect(waitFor(() => triggerMaterializer.mock.calls.some(([reason]) => reason === "obs:alpha"), 1_000)).resolves.toBe(true);

    watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("handles delete and recreate", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-watch-"));
    const repoPath = join(root, "beta");
    mkdirSync(repoPath, { recursive: true });
    const dbPath = join(repoPath, "observability.db");
    writeFileSync(dbPath, "seed");

    const watcher = createObservabilityWatcher([
      { repoSlug: "beta", repoPath, dbPath, mtimeMs: 0 },
    ], { debounceMs: 10 });

    watcher.start();
    rmSync(dbPath);
    writeFileSync(dbPath, "reborn");

    await expect(waitFor(() => triggerMaterializer.mock.calls.some(([reason]) => reason === "obs:beta"), 1_000)).resolves.toBe(true);

    watcher.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("stop prevents later bumps", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-watch-"));
    const repoPath = join(root, "gamma");
    mkdirSync(repoPath, { recursive: true });
    const dbPath = join(repoPath, "observability.db");
    writeFileSync(dbPath, "seed");

    const watcher = createObservabilityWatcher([
      { repoSlug: "gamma", repoPath, dbPath, mtimeMs: 0 },
    ], { debounceMs: 10 });

    watcher.start();
    watcher.stop();
    writeFileSync(dbPath, "next");

    await sleep(300);
    expect(triggerMaterializer).not.toHaveBeenCalled();

    rmSync(root, { recursive: true, force: true });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
