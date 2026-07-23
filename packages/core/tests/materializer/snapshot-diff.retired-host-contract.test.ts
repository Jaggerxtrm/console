import { describe, expect, it } from "vitest";
import { snapshotDiff, snapshotHash } from "../../src/materializer/snapshot-diff.ts";

const keyFn = (row: { id: string }) => row.id;

describe("snapshotDiff", () => {
  it("handles add update delete and unchanged", () => {
    const prev = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }];
    const next = [{ id: "a", value: 1 }, { id: "b", value: 9 }, { id: "d", value: 4 }];
    const result = snapshotDiff(prev, next, keyFn);
    expect(result.unchanged_count).toBe(1);
    expect(result.upserts).toEqual([{ id: "b", value: 9 }, { id: "d", value: 4 }]);
    expect(result.tombstones).toEqual([{ id: "c", value: 3 }]);
  });

  it("hashes stable across row order and object key order", () => {
    const left = snapshotHash([{ id: "b", nested: { y: 2, x: 1 } }, { id: "a", nested: { b: 2, a: 1 } }], keyFn);
    const right = snapshotHash([{ nested: { a: 1, b: 2 }, id: "a" }, { nested: { x: 1, y: 2 }, id: "b" }], keyFn);
    expect(left).toBe(right);
  });
});
