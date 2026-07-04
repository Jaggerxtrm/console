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

  it("starts one immediate refresh and a single interval", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => ["ok"]);
    const lifecycle = new SourceRefreshLifecycle({ refreshIntervalMs: 50, refresh });

    lifecycle.start();
    lifecycle.start();
    await vi.advanceTimersByTimeAsync(125);
    lifecycle.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(4);
    expect(lifecycle.isRunning()).toBe(false);
    vi.useRealTimers();
  });
});

