import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBootstrap } from "../../src/server/database.ts";
import { redactHomePath, resolveDataDir } from "../../src/server/data-dir.ts";
import { CONSOLE_HOST_OWNER, createConsoleHost } from "../../src/server/host.ts";
import { createHostLogger } from "../../src/server/log.ts";
import { CONSOLE_PHASE2_ROUTE_PREFIXES, createConsoleApiRouter } from "../../src/server/routes/index.ts";
import { readStaticAsset, MAX_STATIC_ASSET_BYTES } from "../../src/server/static.ts";
import { createXtrmDatabase } from "../../../../packages/core/src/state/database.ts";

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
  it("describes apps/console as the canonical owner with no compatibility host literal", () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    expect(host.descriptor.owner).toBe(CONSOLE_HOST_OWNER);
    expect(host.descriptor.capabilities).toContain("http-api");
    expect(host.descriptor.capabilities).toContain("static-dashboard");
    expect(host.descriptor.mountedRoutes).toContain("/health");
    expect(host.descriptor.mountedRoutes).toContain("/console");
    expect(host.descriptor.mountedRoutes).toContain("/gitboard");
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

  it("denies a path-traversal target through the console route", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outsidePath = join(distDir, "..", "outside-secret.txt");
    writeFileSync(outsidePath, "must-not-be-served");
    try {
      const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });
      const response = await host.app.request("/console/%2e%2e/outside-secret.txt");
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain("must-not-be-served");
    } finally {
      rmSync(outsidePath, { force: true });
    }
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

  it("permanently redirects legacy Gitboard routes to /console", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML, "assets/app.js": "legacy asset" });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    for (const path of ["/gitboard", "/gitboard/assets/app.js"]) {
      const response = await host.app.request(path);
      expect(response.status, path).toBe(308);
      expect(response.headers.get("location"), path).toBe("/console");
    }
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

  it("mounts the Phase 2 API router through the production host seam", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const stateDir = mkdtempSync(join(tmpdir(), "console-host-phase2-state-"));
    tempDirs.push(stateDir);
    const db = createXtrmDatabase(join(stateDir, "xtrm.sqlite"));
    const logger = silentLogger();
    const api = createConsoleApiRouter({ db, logger });
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger,
      hooks: {
        mountRoutes: (app) => {
          app.route("/", api);
          return CONSOLE_PHASE2_ROUTE_PREFIXES;
        },
      },
    });

    try {
      expect(host.descriptor.mountedRoutes).toEqual(expect.arrayContaining([...CONSOLE_PHASE2_ROUTE_PREFIXES]));
      for (const path of ["/api/feed", "/api/sources", "/api/internal/substrate/schema", "/api/internal/parity/beads"]) {
        const response = await host.app.request(`http://localhost${path}`, { headers: { host: "localhost" } });
        expect(response.status, path).toBe(200);
        await expect(response.json(), path).resolves.toBeTypeOf("object");
      }
      for (const path of ["/api/internal/dolt-health", "/api/internal/substrate/schema", "/api/internal/parity/beads", "/api/internal/parity/observability", "/api/internal/verify-runtime"]) {
        const response = await host.app.request(`http://localhost${path}`, { headers: { host: "localhost.attacker.example" } });
        expect(response.status, path).toBe(403);
      }
    } finally {
      db.close();
    }
  });
});

describe("static asset traversal guard", () => {
  it("refuses paths that escape the dist root", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outside = await readStaticAsset(distDir, "../../../../../../etc/passwd");
    expect(outside).toBeNull();
  });

  it("refuses an in-root leaf symlink whose target lives outside the root", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outsideFile = join(distDir, "..", "outside-secret.txt");
    writeFileSync(outsideFile, "must-not-be-served");
    symlinkSync(outsideFile, join(distDir, "leak.txt"));
    try {
      const asset = await readStaticAsset(distDir, "leak.txt");
      expect(asset).toBeNull();
      const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });
      const response = await host.app.request("/console/leak.txt");
      expect(await response.text()).not.toContain("must-not-be-served");
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it("refuses a symlinked parent directory that points outside the root", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outsideDir = mkdtempSync(join(tmpdir(), "console-host-outside-"));
    tempDirs.push(outsideDir);
    writeFileSync(join(outsideDir, "secret.js"), "must-not-be-served");
    symlinkSync(outsideDir, join(distDir, "sneaky"));
    const asset = await readStaticAsset(distDir, "sneaky/secret.js");
    expect(asset).toBeNull();
  });

  it("serves an in-root symlink whose real target stays inside the root", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML, "assets/real.js": "safe-target" });
    symlinkSync(join(distDir, "assets", "real.js"), join(distDir, "assets", "alias.js"));
    const asset = await readStaticAsset(distDir, "assets/alias.js");
    expect(asset).not.toBeNull();
    expect(new TextDecoder().decode(asset!.body)).toContain("safe-target");
  });

  it("refuses a regular file larger than the exported ceiling", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const big = join(distDir, "big.js");
    const chunk = Buffer.alloc(MAX_STATIC_ASSET_BYTES + 1, 97);
    writeFileSync(big, chunk);
    const asset = await readStaticAsset(distDir, "big.js");
    expect(asset).toBeNull();
  });

  it("keeps the ceiling above every current built console asset", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const distRoot = fileURLToPath(new URL("../../dist/dashboard/console", import.meta.url));
    if (!existsSync(distRoot)) return; // dist not built in this checkout
    const stack = [distRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const full = pjoin(dir, entry);
        const info = statSync(full);
        if (info.isDirectory()) stack.push(full);
        else if (info.isFile()) {
          expect(info.size, full).toBeLessThanOrEqual(MAX_STATIC_ASSET_BYTES);
        }
      }
    }
  });
});

describe("traversal encoding variants", () => {
  const TRAVERSAL_PAYLOADS = [
    ["double-encoded dot-dot-slash", "/console/%252e%252e/outside-secret.txt"],
    ["null byte injection", "/console/%00../outside-secret.txt"],
    ["backslash traversal", "/console/..\\outside-secret.txt"],
    ["mixed-case percent encoding", "/console/%2E%2E/outside-secret.txt"],
    ["unicode dot", "/console/\u2024\u2024/outside-secret.txt"],
    ["dot-dot-slash literal", "/console/../../outside-secret.txt"],
  ] as const;

  it.each(TRAVERSAL_PAYLOADS)("refuses %s", async (_label, path) => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const outsidePath = join(distDir, "..", "outside-secret.txt");
    writeFileSync(outsidePath, "must-not-be-served");
    try {
      const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });
      const response = await host.app.request(path);
      const body = await response.text();
      expect(body).not.toContain("must-not-be-served");
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });
});

describe("308 legacy redirect exact contracts", () => {
  it("redirects /gitboard with query string to /console (no query leak)", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/gitboard?tab=issues&sort=desc");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/console");
  });

  it("redirects deeply nested /gitboard path with query to /console", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/gitboard/repos/org/repo/issues/42?q=1#frag");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/console");
  });

  it("redirects /gitboard with fragment-only suffix to /console", async () => {
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const response = await host.app.request("/gitboard#section");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/console");
  });
});

describe("console host shutdown cleanup", () => {
  function mockBunServe() {
    let stopCalled = 0;
    const fakeServer = {
      port: 9876,
      hostname: "127.0.0.1",
      stop: (_closeActive?: boolean) => { stopCalled++; },
    };
    vi.stubGlobal("Bun", { serve: () => fakeServer });
    return { fakeServer, getStopCount: () => stopCalled };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start binds via Bun.serve and stop releases the listener", async () => {
    const { getStopCount } = mockBunServe();
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const running = await host.start();
    expect(running.port).toBe(9876);
    expect(running.url).toBe("http://127.0.0.1:9876");
    expect(getStopCount()).toBe(0);

    await running.stop();
    expect(getStopCount()).toBe(1);
  });

  it("stop is idempotent (double-stop does not throw or double-release)", async () => {
    const { getStopCount } = mockBunServe();
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({ consoleDistDir: distDir, logger: silentLogger() });

    const running = await host.start();
    await running.stop();
    await expect(running.stop()).resolves.toBeUndefined();
    expect(getStopCount()).toBe(1);
  });

  it("stop invokes stopBackground hook before releasing the listener", async () => {
    mockBunServe();
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const callOrder: string[] = [];
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger: silentLogger(),
      hooks: {
        startBackground: () => { callOrder.push("startBackground"); },
        stopBackground: () => { callOrder.push("stopBackground"); },
      },
    });

    const running = await host.start();
    expect(callOrder).toEqual(["startBackground"]);
    await running.stop();
    expect(callOrder).toEqual(["startBackground", "stopBackground"]);
  });

  it("rolls back startBackground when Bun.serve throws", async () => {
    vi.stubGlobal("Bun", { serve: () => { throw new Error("port-in-use"); } });
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const callOrder: string[] = [];
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger: silentLogger(),
      hooks: {
        startBackground: () => { callOrder.push("startBackground"); },
        stopBackground: () => { callOrder.push("stopBackground"); },
      },
    });

    await expect(host.start()).rejects.toThrow("port-in-use");
    expect(callOrder).toEqual(["startBackground", "stopBackground"]);
  });

  it("sanitizes background rollback failures", async () => {
    vi.stubGlobal("Bun", { serve: () => { throw new Error("port-in-use"); } });
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const lines: string[] = [];
    const logger = createHostLogger({ sink: (line) => lines.push(line) });
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger,
      hooks: {
        stopBackground: () => { throw new Error("/private/path?token=secret"); },
      },
    });

    await expect(host.start()).rejects.toThrow("port-in-use");
    const rollback = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "host.background_rollback_failed");
    expect(rollback).toMatchObject({ error_type: "Error" });
    expect(JSON.stringify(rollback)).not.toContain("private/path");
    expect(JSON.stringify(rollback)).not.toContain("secret");
  });

  it("rejects localhost authorization spoofing from a remote Bun socket peer", async () => {
    let fetchHandler: ((request: Request, server: unknown) => Response | Promise<Response>) | undefined;
    const fakeServer = {
      port: 9876,
      hostname: "127.0.0.1",
      stop: () => {},
      requestIP: () => ({ address: "203.0.113.20", port: 443, family: "IPv4" }),
    };
    vi.stubGlobal("Bun", {
      serve: (options: { fetch: typeof fetchHandler }) => {
        fetchHandler = options.fetch;
        return fakeServer;
      },
    });
    const distDir = makeDistDir({ "index.html": INDEX_HTML });
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger: silentLogger(),
      hooks: {
        mountRoutes: (app) => {
          app.route("/", createConsoleApiRouter({ db: null, logger: silentLogger() }));
          return [...CONSOLE_PHASE2_ROUTE_PREFIXES];
        },
      },
    });
    const running = await host.start();
    try {
      const response = await fetchHandler!(new Request("http://localhost/api/internal/verify-runtime", {
        headers: { host: "localhost", origin: "http://localhost", "x-xtrm-peer-address": "127.0.0.1" },
      }), fakeServer);
      expect(response.status).toBe(403);
    } finally {
      await running.stop();
    }
  });
});

describe("host-neutral data directory seam", () => {
  it("prefers XTRM_DATA_DIR", () => {
    const resolution = resolveDataDir({ XTRM_DATA_DIR: "/tmp/xtrm-data", GITBOARD_DATA_DIR: "/tmp/legacy" }, "/home/u");
    expect(resolution.source).toBe("XTRM_DATA_DIR");
    expect(resolution.dataDir).toBe("/tmp/xtrm-data");
    expect(resolution.storeDbPath).toBe("/tmp/xtrm-data/xtrm.sqlite");
  });

  it("falls back to GITBOARD_DATA_DIR when XTRM_DATA_DIR is blank", () => {
    const resolution = resolveDataDir({ XTRM_DATA_DIR: "  ", GITBOARD_DATA_DIR: " /tmp/legacy " }, "/home/u");
    expect(resolution.source).toBe("GITBOARD_DATA_DIR");
    expect(resolution.dataDir).toBe("/tmp/legacy");
    expect(resolution.storeDbPath).toBe("/tmp/legacy/xtrm.sqlite");
  });

  it("defaults to the production home .agent-forge directory", () => {
    const resolution = resolveDataDir({}, "/home/u");
    expect(resolution.source).toBe("default");
    expect(resolution.dataDir).toBe("/home/u/.agent-forge");
    expect(resolution.storeDbPath).toBe("/home/u/.agent-forge/xtrm.sqlite");
    expect(resolution.legacyFoldDbPath).toBe("/home/u/.agent-forge/gitboard.sqlite");
  });
});

describe("home path redaction", () => {
  it("replaces the home prefix with a tilde", () => {
    expect(redactHomePath("/home/u/.xtrm", "/home/u")).toBe("~/.xtrm");
    expect(redactHomePath("/home/u", "/home/u")).toBe("~");
    expect(redactHomePath("/etc/xtrm", "/home/u")).toBe("/etc/xtrm");
  });

  it("emits structured host configuration with redacted paths", () => {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const lines: string[] = [];
      const home = homedir();
      const distDir = join(home, "console-host-redaction-dist");
      const dataDir = resolveDataDir({ XTRM_DATA_DIR: join(home, ".xtrm") }, home);
      createConsoleHost({
        consoleDistDir: distDir,
        dataDir,
        logger: createHostLogger({
          sink: (line) => lines.push(line),
          now: () => new Date("2026-07-22T00:00:00.000Z"),
        }),
      });

      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(entry).toMatchObject({
        level: "debug",
        component: "console-host",
        event: "host.configured",
        dataDirSource: "XTRM_DATA_DIR",
        consoleDistSource: "configured",
      });
      expect(lines[0]).not.toContain(home);
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
  });
});

describe("host logger envelope authority", () => {
  it("keeps reserved envelope fields authoritative against caller fields", () => {
    const lines: string[] = [];
    const logger = createHostLogger({
      sink: (line) => lines.push(line),
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    logger.info("host.configured", {
      ts: "attacker-ts",
      level: "error",
      component: "attacker-component",
      event: "attacker-event",
      owner: "apps/console",
    });

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.ts).toBe("2026-07-22T00:00:00.000Z");
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("console-host");
    expect(entry.event).toBe("host.configured");
    // Non-reserved caller fields still pass through.
    expect(entry.owner).toBe("apps/console");
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
    expect(bootstrap.legacyFoldDbPath).toBe(join(dataDir.dataDir, "gitboard.sqlite"));
    expect(bootstrap.storeDbPath).not.toContain("state.sqlite");
    expect(bootstrap.legacyFoldDbPath).not.toContain("state.sqlite");
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
