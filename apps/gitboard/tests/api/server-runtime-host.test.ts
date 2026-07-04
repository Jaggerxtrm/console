import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.ts";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";
import { BeadsChangeWatcher } from "../../src/core/beads-change-watcher.ts";
import { ProjectScanner } from "../../src/core/project-scanner.ts";
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
