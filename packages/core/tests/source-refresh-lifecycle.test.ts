import { describe, expect, it, vi } from "vitest";
import { SourceRefreshLifecycle } from "../src/runtime/source-refresh-lifecycle.ts";

describe("SourceRefreshLifecycle", () => {
  it("collapses concurrent refresh calls", async () => {
    let calls = 0;
    let resolveRefresh!: (value: string[]) => void;
    const lifecycle = new SourceRefreshLifecycle({
      refreshIntervalMs: 1000,
      refresh: async () => {
        calls += 1;
        return new Promise<string[]>((resolve) => {
          resolveRefresh = resolve;
        });
      },
    });

    const first = lifecycle.refresh();
    const second = lifecycle.refresh();
    resolveRefresh(["ok"]);

    await expect(Promise.all([first, second])).resolves.toEqual([["ok"], ["ok"]]);
    expect(calls).toBe(1);
  });

  it("clears in-flight refresh after rejection", async () => {
    let calls = 0;
    let rejectRefresh!: (error: Error) => void;
    const lifecycle = new SourceRefreshLifecycle({
      refreshIntervalMs: 1000,
      refresh: () => {
        calls += 1;
        if (calls === 1) return new Promise<string[]>((_resolve, reject) => { rejectRefresh = reject; });
        return Promise.resolve(["recovered"]);
      },
    });

    const first = lifecycle.refresh();
    rejectRefresh(new Error("synthetic refresh failure"));
    await expect(first).rejects.toThrow("synthetic refresh failure");
    await expect(lifecycle.refresh()).resolves.toEqual(["recovered"]);
    expect(calls).toBe(2);
  });

  it("starts one immediate refresh and a single interval", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => ["ok"]);
    const lifecycle = new SourceRefreshLifecycle({ refreshIntervalMs: 50, refresh });

    lifecycle.start();
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(125);
    await lifecycle.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4);
    expect(lifecycle.isRunning()).toBe(false);
    vi.useRealTimers();
  });

  it("drains an in-flight refresh and rejects new work after stop", async () => {
    let resolveRefresh!: (value: string[]) => void;
    const lifecycle = new SourceRefreshLifecycle({
      refreshIntervalMs: 60_000,
      refresh: () => new Promise<string[]>((resolve) => { resolveRefresh = resolve; }),
    });

    lifecycle.start();
    let stopSettled = false;
    const stopping = lifecycle.stop().then(() => { stopSettled = true; });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    await expect(lifecycle.refresh()).rejects.toThrow("source refresh stopped");
    resolveRefresh(["done"]);
    await stopping;
    expect(stopSettled).toBe(true);
  });
});
