import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseBootstrap } from "../../src/server/database.ts";
import { redactHomePath, resolveDataDir } from "../../src/server/data-dir.ts";
import { CONSOLE_HOST_OWNER, createConsoleHost } from "../../src/server/host.ts";
import { createHostLogger } from "../../src/server/log.ts";
import { readStaticAsset } from "../../src/server/static.ts";

const tempDirs: string[] = [];

function makeDistDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "console-host-dist-"));
  tempDirs.push(dir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(dir, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function silentLogger() {
  return createHostLogger({ sink: () => {} });
}

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const INDEX_HTML = "<!doctype html><html><body>console-host-fixture</body></html>";

describe("console host descriptor", () => {
  it("describes apps/console as owner while retaining the compatibility host literal", () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    expect(host.descriptor.owner).toBe(CONSOLE_HOST_OWNER);
    expect(host.descriptor.compatibilityHost).toBe("apps/gitboard");
    expect(host.descriptor.capabilities).toContain("http-api");
    expect(host.descriptor.capabilities).toContain("static-dashboard");
    expect(host.descriptor.mountedRoutes).toContain("/health");
    expect(host.descriptor.mountedRoutes).toContain("/console");
  });
});

describe("console host routing", () => {
  it("serves a stable /health JSON contract", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "console-host",
      owner: "apps/console",
    });
  });

  it("serves the console SPA index and static assets", async () => {
    const distDir = makeDistDir({
      "index.html": INDEX_HTML,
      "assets/app.js": "export const answer = 42;",
    });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const index = await host.app.request("/console");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("console-host-fixture");

    const asset = await host.app.request("/console/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("answer = 42");
  });

  it("falls back to the SPA index for unknown client routes", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/console/specialists/deep/route");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("console-host-fixture");
  });

  it("fails loud when the console dist is missing", async () => {
    const distDir = makeDistDir({});
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/console");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error", error: "console-dist-missing" });
  });

  it("redirects the bare root to /console", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/console");
  });
});

describe("console host lifecycle hook contract", () => {
  it("records route prefixes returned by the mountRoutes hook", () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger: silentLogger(),
      hooks: { mountRoutes: () => ["/api/console/feed"] },
    });

    expect(host.descriptor.mountedRoutes).toContain("/api/console/feed");
    expect(host.descriptor.capabilities).toContain("http-api");
  });
});

describe("static asset traversal guard", () => {
  it("refuses paths that escape the dist root", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outside = await readStaticAsset(distDir, "../../../../../../etc/passwd");
    expect(outside).toBeNull();
  });
});

describe("host-neutral data directory seam", () => {
  it("prefers XTRM_DATA_DIR", () => {
    const resolution = resolveDataDir({ XTRM_DATA_DIR: "/tmp/xtrm-data", GITBOARD_DATA_DIR: "/tmp/legacy" }, "/home/u");
    expect(resolution.source).toBe("XTRM_DATA_DIR");
    expect(resolution.dataDir).toBe("/tmp/xtrm-data");
    expect(resolution.storeDbPath).toBe("/tmp/xtrm-data/xtrm.sqlite");
  });

  it("falls back to GITBOARD_DATA_DIR when XTRM_DATA_DIR is unset", () => {
    const resolution = resolveDataDir({ GITBOARD_DATA_DIR: "/tmp/legacy" }, "/home/u");
    expect(resolution.source).toBe("GITBOARD_DATA_DIR");
    expect(resolution.dataDir).toBe("/tmp/legacy");
  });

  it("defaults to the home .xtrm directory", () => {
    const resolution = resolveDataDir({}, "/home/u");
    expect(resolution.source).toBe("default");
    expect(resolution.dataDir).toBe("/home/u/.xtrm");
  });
});

describe("home path redaction", () => {
  it("replaces the home prefix with a tilde", () => {
    expect(redactHomePath("/home/u/.xtrm", "/home/u")).toBe("~/.xtrm");
    expect(redactHomePath("/home/u", "/home/u")).toBe("~");
    expect(redactHomePath("/etc/xtrm", "/home/u")).toBe("/etc/xtrm");
  });
});

describe("console database bootstrap seam", () => {
  it("ensures the data directory exists without opening state", () => {
    const base = mkdtempSync(join(tmpdir(), "console-host-db-"));
    tempDirs.push(base);
    const dataDir = resolveDataDir({ XTRM_DATA_DIR: join(base, "nested", "data") }, "/home/u");
    const bootstrap = createDatabaseBootstrap(dataDir, () => {
      throw new Error("factory must not run for ensureDataDir");
    });

    expect(bootstrap.storeDbPath).toBe(join(dataDir.dataDir, "xtrm.sqlite"));
    expect(existsSync(dataDir.dataDir)).toBe(false);
    bootstrap.ensureDataDir();
    expect(existsSync(dataDir.dataDir)).toBe(true);
  });

  it("defers open/close to the injected factory and delegates close", () => {
    const base = mkdtempSync(join(tmpdir(), "console-host-db-open-"));
    tempDirs.push(base);
    const dataDir = resolveDataDir({ XTRM_DATA_DIR: base }, "/home/u");
    let closed = false;
    const openedPaths: string[] = [];
    const fakeDb = { close: () => { closed = true; } } as unknown as import("bun:sqlite").Database;
    const bootstrap = createDatabaseBootstrap(dataDir, (path) => {
      openedPaths.push(path);
      return fakeDb;
    });

    const handle = bootstrap.open();
    expect(openedPaths).toEqual([dataDir.storeDbPath]);
    expect(handle.db).toBe(fakeDb);
    expect(closed).toBe(false);
    handle.close();
    expect(closed).toBe(true);
  });
});
