import { describe, expect, it, vi } from "vitest";
import {
  BoundedMaterializerScheduler,
  createAdapterRegistry,
  COALESCE_MS,
  Materializer,
  snapshotDiff,
  snapshotHash,
  SourceQueue,
} from "../src/materializer/index.ts";
import type { MaterializerAdapter } from "../src/materializer/index.ts";

const keyFn = (row: { id: string }) => row.id;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("core materializer infrastructure", () => {
  it("exports a typed adapter registry", () => {
    const registry = createAdapterRegistry();
    const adapter = {} as MaterializerAdapter;
    registry.set("source:a", adapter);
    expect(registry.get("source:a")).toBe(adapter);
  });

  it("exports the core Materializer implementation", () => {
    const materializer = new Materializer({} as never);
    expect(() => materializer.trigger("missing:source")).toThrow("unknown source: missing:source");
  });

  it("diffs and hashes snapshots stably", () => {
    const prev = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];
    const next = [{ id: "a", value: 1 }, { id: "b", value: 9 }, { id: "d", value: 4 }];
    expect(snapshotDiff(prev, next, keyFn)).toEqual({
      unchanged_count: 1,
      upserts: [{ id: "b", value: 9 }, { id: "d", value: 4 }],
      tombstones: [{ id: "c", value: 3 }],
    });

    const left = snapshotHash([{ id: "b", nested: { y: 2, x: 1 } }, { id: "a", nested: { b: 2, a: 1 } }], keyFn);
    const right = snapshotHash([{ nested: { a: 1, b: 2 }, id: "a" }, { nested: { x: 1, y: 2 }, id: "b" }], keyFn);
    expect(left).toBe(right);
  });

  it("coalesces queued runs and reports source errors", async () => {
    vi.useFakeTimers();
    try {
      const errors: Array<{ sourceKey: string; error: unknown }> = [];
      const queue = new SourceQueue((sourceKey, error) => errors.push({ sourceKey, error }));
      let runs = 0;

      queue.enqueue("source:a", async () => {
        runs += 1;
        throw new Error("boom");
      });
      queue.enqueue("source:a", async () => {
        runs += 1;
      });

      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      expect(runs).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.sourceKey).toBe("source:a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels queued source work and waits for an active drain during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = new SourceQueue();
      let cancelledRuns = 0;
      cancelled.enqueue("source:cancelled", async () => { cancelledRuns += 1; });
      await cancelled.stop();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      expect(cancelledRuns).toBe(0);

      const active = new SourceQueue();
      const gate = deferred<void>();
      let activeRuns = 0;
      active.enqueue("source:active", async () => {
        activeRuns += 1;
        await gate.promise;
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      let stopped = false;
      const stopping = active.stop().then(() => { stopped = true; });
      await flushMicrotasks();
      expect(stopped).toBe(false);
      gate.resolve();
      await stopping;
      expect(activeRuns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds more than 21 unique sources and resolves every accepted completion", async () => {
    const scheduler = new BoundedMaterializerScheduler(2, 8);
    const sources = Array.from({ length: 32 }, (_, index) => `source:${index}`);
    const waiting = [...sources];
    const gates = new Map<string, Deferred<void>>();
    const completions = new Map<string, Promise<void>>();
    const inFlight = new Set<string>();
    const finished = new Set<string>();
    let rejectedSubmissions = 0;
    let active = 0;
    let peakActive = 0;

    const submitWaiting = (): void => {
      for (const sourceKey of [...waiting]) {
        const gate = deferred<void>();
        gates.set(sourceKey, gate);
        const scheduled = scheduler.submit(sourceKey, async () => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          inFlight.add(sourceKey);
          try {
            await gates.get(sourceKey)?.promise;
            finished.add(sourceKey);
          } finally {
            inFlight.delete(sourceKey);
            active -= 1;
          }
        });
        if (!scheduled.accepted) {
          rejectedSubmissions += 1;
          gates.delete(sourceKey);
          continue;
        }
        waiting.splice(waiting.indexOf(sourceKey), 1);
        completions.set(sourceKey, scheduled.completion);
      }
    };

    submitWaiting();
    while (finished.size < sources.length) {
      await flushMicrotasks();
      const stats = scheduler.getStats();
      expect(stats.active).toBeLessThanOrEqual(2);
      expect(stats.pending).toBeLessThanOrEqual(8);
      const current = [...inFlight];
      expect(current.length).toBeGreaterThan(0);
      for (const sourceKey of current) gates.get(sourceKey)?.resolve();
      await Promise.all(current.map((sourceKey) => completions.get(sourceKey)));
      await flushMicrotasks();
      submitWaiting();
    }

    expect(waiting).toHaveLength(0);
    expect(rejectedSubmissions).toBeGreaterThan(0);
    expect(finished).toEqual(new Set(sources));
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(scheduler.getStats()).toMatchObject({ active: 0, pending: 0, maxActive: 2, pendingLimit: 8 });
    expect(scheduler.getStats().maxPending).toBeLessThanOrEqual(8);

    const failure = new Error("scheduler failure");
    const rejected = scheduler.submit("source:reject", async () => { throw failure; });
    expect(rejected.accepted).toBe(true);
    if (rejected.accepted) await expect(rejected.completion).rejects.toBe(failure);
    expect(scheduler.getStats()).toMatchObject({ active: 0, pending: 0 });
  });

  it("frees bounded slot after rejection and resolves following queued work", async () => {
    const scheduler = new BoundedMaterializerScheduler(1, 8);
    const failure = new Error("first run failed");
    let nextRuns = 0;
    const failed = scheduler.submit("source:failed", async () => { throw failure; });
    const next = scheduler.submit("source:next", async () => { nextRuns += 1; });

    expect(failed.accepted).toBe(true);
    expect(next.accepted).toBe(true);
    if (failed.accepted) await expect(failed.completion).rejects.toBe(failure);
    if (next.accepted) await expect(next.completion).resolves.toBeUndefined();
    expect(nextRuns).toBe(1);
    expect(scheduler.getStats()).toMatchObject({ active: 0, pending: 0, maxActive: 1 });
  });
});
