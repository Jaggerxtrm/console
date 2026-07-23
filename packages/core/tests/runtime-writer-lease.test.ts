import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRuntimeWriterLease } from "../src/runtime/writer-lease.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime writer lease", () => {
  it("allows exactly one active writer for a state database", () => {
    const root = mkdtempSync(join(tmpdir(), "console-writer-lease-"));
    roots.push(root);
    const dbPath = join(root, "xtrm.sqlite");
    const first = acquireRuntimeWriterLease(dbPath, { owner: "apps/console" });

    expect(() => acquireRuntimeWriterLease(dbPath, { owner: "apps/gitboard" })).toThrow(/active runtime writer/i);

    first.release();
    const second = acquireRuntimeWriterLease(dbPath, { owner: "apps/gitboard" });
    expect(second.owner).toBe("apps/gitboard");
    second.release();
  });

  it("releases the kernel-owned lease independently of persisted sidecar state", () => {
    const root = mkdtempSync(join(tmpdir(), "console-writer-release-"));
    roots.push(root);
    const dbPath = join(root, "xtrm.sqlite");
    const first = acquireRuntimeWriterLease(dbPath, { owner: "apps/console" });
    first.release();

    expect(() => {
      const replacement = acquireRuntimeWriterLease(dbPath, { owner: "apps/gitboard" });
      replacement.release();
    }).not.toThrow();
  });
});
