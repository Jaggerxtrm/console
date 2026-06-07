import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/server.ts";
import { createXtrmDatabase } from "../../src/core/xtrm-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

    const response = await app.request("/health");
    expect(response.status).toBe(200);
  });
});
