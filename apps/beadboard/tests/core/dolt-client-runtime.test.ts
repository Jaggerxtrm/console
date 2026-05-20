import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools: Array<{ key: string; end: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> }> = [];
const executeByPort = new Map<number, ReturnType<typeof vi.fn>>();

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn((config: { host: string; port: number; database?: string; user?: string }) => {
      const execute = executeByPort.get(config.port) ?? vi.fn(async () => [[{ ok: 1 }], undefined]);
      const pool = {
        key: `${config.host}:${config.port}/${config.database ?? "dolt"}/${config.user ?? "root"}`,
        end: vi.fn(async () => undefined),
        execute,
      };
      pools.push(pool);
      return pool;
    }),
  },
}));

vi.mock("../../../gitboard/src/core/logger.ts", () => ({
  emit: vi.fn(),
  makeLogEntry: vi.fn((source: string, event: string, level: string, message?: string, meta?: Record<string, unknown>) => ({ source, event, level, message, meta })),
}));

const { DoltClient, getDoltHealthSnapshot, resetDoltRuntimeForTests } = await import("../../src/core/dolt-client.ts");

beforeEach(() => {
  pools.length = 0;
  executeByPort.clear();
  resetDoltRuntimeForTests();
});

afterEach(() => {
  resetDoltRuntimeForTests();
  vi.restoreAllMocks();
});

describe("DoltClient runtime isolation", () => {
  it("keeps separate pools alive for separate pool keys", async () => {
    const first = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_a", user: "root" });
    const second = new DoltClient({ host: "127.0.0.1", port: 3307, database: "repo_b", user: "root" });

    await first.connect();
    await second.connect();

    expect(pools).toHaveLength(2);
    expect(pools[0].end).not.toHaveBeenCalled();
    expect(pools[1].end).not.toHaveBeenCalled();
    expect(first.isConnected()).toBe(true);
    expect(second.isConnected()).toBe(true);
  });

  it("keeps same-port databases in separate runtime keys", async () => {
    const first = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_a", user: "root" });
    const second = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_b", user: "root" });

    await first.connect();
    await second.connect();

    expect(pools.map((pool) => pool.key)).toEqual([
      "127.0.0.1:3306/repo_a/root",
      "127.0.0.1:3306/repo_b/root",
    ]);
    expect(pools[0].end).not.toHaveBeenCalled();
  });

  it("disconnects only the caller runtime", async () => {
    const first = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_a", user: "root" });
    const second = new DoltClient({ host: "127.0.0.1", port: 3307, database: "repo_b", user: "root" });

    await first.connect();
    await second.connect();
    await first.disconnect();

    expect(pools[0].end).toHaveBeenCalledTimes(1);
    expect(pools[1].end).not.toHaveBeenCalled();
    expect(first.isConnected()).toBe(false);
    expect(second.isConnected()).toBe(true);
  });

  it("opens breaker for one pool key without blocking another pool key", async () => {
    executeByPort.set(3306, vi.fn(async () => { throw new Error("port 3306 down"); }));
    executeByPort.set(3307, vi.fn(async () => [[{ total: 1, open: 1, in_progress: 0, blocked: 0, closed: 0 }], undefined]));
    const broken = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_a" });
    const healthy = new DoltClient({ host: "127.0.0.1", port: 3307, database: "repo_b" });

    for (let i = 0; i < 5; i += 1) {
      await expect(broken.probeHealth()).resolves.toBe(false);
    }

    expect(broken.isBreakerOpen()).toBe(true);
    expect(healthy.isBreakerOpen()).toBe(false);
    await expect(healthy.getStats()).resolves.toEqual({ total: 1, open: 1, in_progress: 0, blocked: 0, closed: 0 });
  });

  it("returns health for the requested pool key instead of global singleton state", async () => {
    executeByPort.set(3306, vi.fn(async () => { throw new Error("port 3306 down"); }));
    const broken = new DoltClient({ host: "127.0.0.1", port: 3306, database: "repo_a" });
    const healthy = new DoltClient({ host: "127.0.0.1", port: 3307, database: "repo_b" });

    await healthy.connect();
    await broken.probeHealth();

    expect(getDoltHealthSnapshot("127.0.0.1:3306/repo_a/root").consecutiveFailures).toBe(1);
    expect(getDoltHealthSnapshot("127.0.0.1:3307/repo_b/root").consecutiveFailures).toBe(0);
  });
});
