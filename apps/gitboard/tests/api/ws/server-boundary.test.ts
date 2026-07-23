import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { getCurrentRegistry, startServer } from "../../../src/api/server.ts";

type ServerOptions = {
  fetch: (request: Request, server: { requestIP(request: Request): { address: string } | null; upgrade(request: Request, options?: unknown): boolean }) => Response | undefined | Promise<Response | undefined>;
  websocket: {
    backpressureLimit: number;
    closeOnBackpressureLimit: boolean;
    open: (ws: unknown) => void;
    message: (ws: unknown, message: { toString(): string }) => void;
  };
};

const tempDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Gitboard realtime Bun boundary", () => {
  it("configures bounded Bun queues and forwards backpressure close code", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-ws-boundary-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    databases.push(db);
    let options: ServerOptions | undefined;
    const fakeServer = { upgrade: vi.fn(() => true), requestIP: vi.fn(() => ({ address: "203.0.113.20" })) };
    const serve = vi.fn((next: ServerOptions) => {
      options = next;
      return fakeServer;
    });
    vi.stubGlobal("Bun", { serve });

    startServer(db, { port: 0, hostname: "127.0.0.1" });

    expect(serve).toHaveBeenCalledOnce();
    expect(options?.websocket.backpressureLimit).toBe(1024 * 1024);
    expect(options?.websocket.closeOnBackpressureLimit).toBe(true);

    const spoofed = options?.fetch(new Request("http://localhost/api/console/ws", {
      headers: { host: "localhost", origin: "http://localhost", upgrade: "websocket" },
    }), fakeServer);
    expect(spoofed).toBeInstanceOf(Response);
    expect((spoofed as Response).status).toBe(403);

    const hostilePrefix = await options?.fetch(new Request("http://localhost.attacker.tld/api/internal/parity/beads", {
      headers: { host: "localhost.attacker.tld" },
    }), fakeServer);
    expect(hostilePrefix).toBeInstanceOf(Response);
    expect(hostilePrefix?.status).toBe(403);

    const ws = {
      data: { path: "/api/console/ws" },
      send: vi.fn(() => -1),
      close: vi.fn(),
    };
    options?.websocket.open(ws);
    options?.websocket.message(ws, {
      toString: () => JSON.stringify({ action: "subscribe", channel: "system", version: "1" }),
    });
    getCurrentRegistry()?.publish("system", "system:log", { marker: "slow-client" });

    expect(ws.close).toHaveBeenCalledWith(1013);
  });
});
