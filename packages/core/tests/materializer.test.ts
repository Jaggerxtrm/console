import { describe, expect, it, vi } from "vitest";
import { createAdapterRegistry, COALESCE_MS, Materializer, snapshotDiff, snapshotHash, SourceQueue } from "../src/materializer/index.ts";
import type { MaterializerAdapter } from "../src/materializer/index.ts";

const keyFn = (row: { id: string }) => row.id;

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
    vi.useRealTimers();
  });
});
