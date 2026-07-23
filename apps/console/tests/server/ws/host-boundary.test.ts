import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleHost } from "../../../src/server/host.ts";
import { createHostLogger } from "../../../src/server/log.ts";
import { createConsoleRealtime } from "../../../src/server/ws/realtime.ts";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Console realtime Bun host boundary", () => {
  it("installs bounded handlers and routes a real upgrade through the Console adapter", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "console-ws-host-"));
    roots.push(distDir);
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>console</title>");
    const logger = createHostLogger({ sink: () => {}, diskEnabled: false });
    const realtime = createConsoleRealtime({ logger });
    let serveOptions: {
      fetch: (request: Request, server: typeof fakeServer) => Promise<Response | undefined>;
      websocket: Bun.WebSocketHandler<{ path?: string }>;
    } | undefined;
    const fakeServer = {
      port: 9876,
      hostname: "127.0.0.1",
      requestIP: vi.fn(() => ({ address: "127.0.0.1", port: 1234, family: "IPv4" })),
      upgrade: vi.fn(() => true),
      stop: vi.fn(),
    };
    vi.stubGlobal("Bun", {
      serve: (options: typeof serveOptions) => {
        serveOptions = options;
        return fakeServer;
      },
    });
    const host = createConsoleHost({
      consoleDistDir: distDir,
      logger,
      runtimeCapabilities: ["websocket"],
      hooks: {
        handleWebSocketUpgrade: realtime.handleUpgrade,
        websocket: realtime.websocket,
      },
    });

    const running = await host.start();
    const request = new Request("http://localhost/api/console/ws", {
      headers: { host: "localhost", origin: "http://localhost", upgrade: "websocket" },
    });
    const response = await serveOptions?.fetch(request, fakeServer);

    expect(response).toBeUndefined();
    expect(fakeServer.upgrade).toHaveBeenCalledWith(request, { data: { path: "/api/console/ws" } });
    expect(serveOptions?.websocket.backpressureLimit).toBe(1024 * 1024);
    expect(serveOptions?.websocket.closeOnBackpressureLimit).toBe(true);
    expect(host.descriptor.capabilities).toContain("websocket");
    await running.stop();
  });
});
