import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservabilityWatcher } from "../../src/observability/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("observability watcher", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("debounces database changes through the injected materializer port", async () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-watcher-"));
    roots.push(root);
    const repoPath = join(root, "alpha");
    mkdirSync(repoPath, { recursive: true });
    const dbPath = join(repoPath, "observability.db");
    writeFileSync(dbPath, "seed");
    const trigger = vi.fn();
    const watcher = createObservabilityWatcher([{ repoSlug: "alpha", repoPath, dbPath, mtimeMs: 0 }], { debounceMs: 10, triggerMaterializer: trigger });

    watcher.start();
    writeFileSync(dbPath, "next");
    await expect.poll(() => trigger.mock.calls.some(([reason]) => reason === "obs:alpha"), { timeout: 1_000 }).toBe(true);
    watcher.stop();
  });

  it("does not trigger after stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "core-observability-watcher-stop-"));
    roots.push(root);
    const repoPath = join(root, "beta");
    mkdirSync(repoPath, { recursive: true });
    const dbPath = join(repoPath, "observability.db");
    writeFileSync(dbPath, "seed");
    const trigger = vi.fn();
    const watcher = createObservabilityWatcher([{ repoSlug: "beta", repoPath, dbPath, mtimeMs: 0 }], { debounceMs: 10, triggerMaterializer: trigger });
    watcher.start();
    watcher.stop();
    writeFileSync(dbPath, "next");
    await sleep(150);
    expect(trigger).not.toHaveBeenCalled();
  });
});
