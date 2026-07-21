import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/server.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { BeadsChangeWatcher } from "../../src/core/beads-change-watcher.ts";
import { ProjectScanner } from "../../src/core/project-scanner.ts";
import { UnifiedScanner } from "../../src/core/unified-scanner.ts";
import { TriggerWatcher } from "../../src/server/beads/trigger-watcher.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";

const tempDirs: string[] = [];
const originalDatasetteDebug = process.env.EXPLORE_DATASETTE_DEBUG;

afterEach(() => {
  if (originalDatasetteDebug === undefined) delete process.env.EXPLORE_DATASETTE_DEBUG;
  else process.env.EXPLORE_DATASETTE_DEBUG = originalDatasetteDebug;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

class EmptyScanner extends ProjectScanner {
  override async scanAll() { return []; }
}

describe("gitboard runtime host compatibility", () => {
  it("describes the app as a compatibility host while preserving mounted APIs", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-runtime-host-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const { app, materializer, registry, runtimeHost } = createApp(db, db);

    expect(runtimeHost.compatibilityHost).toBe("apps/gitboard");
    expect(runtimeHost.storeDb).toBe(db);
    expect(runtimeHost.stateDb).toBe(db);
    expect(runtimeHost.materializer).toBe(materializer);
    expect(runtimeHost.registry).toBe(registry);
    expect(runtimeHost.capabilities).toContain("http-api");
    expect(runtimeHost.capabilities).toContain("materializer");
    expect(runtimeHost.mountedRoutes).toContain("/api/feed");
    expect(runtimeHost.mountedRoutes).toContain("/api/internal");
    expect(runtimeHost.mountedRoutes).not.toContain("/explore/sql");
    expect(runtimeHost.staticServiceParity).toEqual([
      expect.objectContaining({ route: "/console", state: "retained" }),
      expect.objectContaining({ route: "/gitboard", state: "retained" }),
      expect.objectContaining({ route: "/health", state: "retained" }),
      expect.objectContaining({ route: "runtime-descriptor", state: "retained" }),
    ]);
    expect(runtimeHost.staticServiceParity.flatMap((route) => route.blockers).length).toBeGreaterThan(0);

    const response = await app.request("/health");
    expect(response.status).toBe(200);
  });

  it("starts beads discovery after unified startup refresh completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-runtime-host-sequencing-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const events: string[] = [];
    let releaseRefresh!: () => void;
    const refresh = new Promise<never[]>((resolve) => { releaseRefresh = () => resolve([]); });
    const scannerStart = vi.spyOn(UnifiedScanner.prototype, "start").mockImplementation(() => { events.push("scanner.start"); });
    const scannerRefresh = vi.spyOn(UnifiedScanner.prototype, "refresh").mockReturnValue(refresh);
    const watcherStart = vi.spyOn(TriggerWatcher.prototype, "start").mockImplementation(() => { events.push("watcher.start"); });

    try {
      createApp(db, db);
      expect(events).toEqual(["scanner.start"]);

      releaseRefresh();
      await refresh;
      await Promise.resolve();

      expect(events).toEqual(["scanner.start", "watcher.start"]);
      expect(scannerRefresh).toHaveBeenCalledTimes(1);
    } finally {
      scannerStart.mockRestore();
      scannerRefresh.mockRestore();
      watcherStart.mockRestore();
      db.close();
    }
  });

  it("does not start stale watcher after a newer app lifecycle replaces it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-runtime-host-stale-lifecycle-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const refreshes: Array<Promise<never[]>> = [];
    const releases: Array<(value: never[]) => void> = [];
    let watcherStarts = 0;
    const scannerStart = vi.spyOn(UnifiedScanner.prototype, "start").mockImplementation(() => undefined);
    const scannerRefresh = vi.spyOn(UnifiedScanner.prototype, "refresh").mockImplementation(() => {
      const refresh = new Promise<never[]>((resolve) => { releases.push(resolve); });
      refreshes.push(refresh);
      return refresh;
    });
    const watcherStart = vi.spyOn(TriggerWatcher.prototype, "start").mockImplementation(() => { watcherStarts += 1; });

    try {
      createApp(db, db);
      createApp(db, db);
      expect(scannerRefresh).toHaveBeenCalledTimes(2);

      releases[0]([]);
      await refreshes[0];
      await Promise.resolve();
      await Promise.resolve();
      expect(watcherStarts).toBe(0);

      releases[1]([]);
      await refreshes[1];
      await Promise.resolve();
      await Promise.resolve();
      expect(watcherStarts).toBe(1);
    } finally {
      scannerStart.mockRestore();
      scannerRefresh.mockRestore();
      watcherStart.mockRestore();
      db.close();
    }
  });

  it("publishes Datasette SQL proxy only when explicit debug flag is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-runtime-host-debug-"));
    tempDirs.push(root);
    process.env.EXPLORE_DATASETTE_DEBUG = "1";
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    const { runtimeHost } = createApp(db, db);

    expect(runtimeHost.mountedRoutes).toContain("/explore/sql");
  });

  it("loads beads watcher compatibility adapter against core runtime boundary", () => {
    const watcher = new BeadsChangeWatcher({
      registry: new ChannelRegistry(),
      scanner: new EmptyScanner(),
    });

    expect(() => watcher.start()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
  });
});
