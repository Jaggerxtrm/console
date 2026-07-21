import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXtrmDatabase } from "../../../src/core/xtrm-store.ts";
import { getCurrentRegistry, startServer } from "../../../src/api/server.ts";

type ServerOptions = {
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
  it("configures bounded Bun queues and forwards backpressure close code", () => {
    const root = mkdtempSync(join(tmpdir(), "gitboard-ws-boundary-"));
    tempDirs.push(root);
    const db = createXtrmDatabase(join(root, "xtrm.sqlite"));
    databases.push(db);
    let options: ServerOptions | undefined;
    const fakeServer = { upgrade: vi.fn(() => true) };
    const serve = vi.fn((next: ServerOptions) => {
      options = next;
      return fakeServer;
    });
    vi.stubGlobal("Bun", { serve });

    startServer(db, { port: 0, hostname: "127.0.0.1" });

    expect(serve).toHaveBeenCalledOnce();
    expect(options?.websocket.backpressureLimit).toBe(1024 * 1024);
    expect(options?.websocket.closeOnBackpressureLimit).toBe(true);

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
