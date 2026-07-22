import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReproInputs, runWithCleanup, MAX_TARGET_MB, MAX_ROWS } from "./filecache-repro";

describe("parseReproInputs — bounded positive integers", () => {
  test("defaults parse", () => {
    const r = parseReproInputs({});
    expect(r.targetMb).toBe(384);
    expect(r.rows).toBe(60000);
  });

  test("rejects NaN / non-finite / non-integer / non-positive", () => {
    expect(() => parseReproInputs({ REPRO_SIZE_MB: "abc" })).toThrow(/positive integer/);
    expect(() => parseReproInputs({ REPRO_SIZE_MB: "NaN" })).toThrow();
    expect(() => parseReproInputs({ REPRO_SIZE_MB: "0" })).toThrow();
    expect(() => parseReproInputs({ REPRO_ROWS: "-5" })).toThrow(/positive integer/);
    expect(() => parseReproInputs({ REPRO_ROWS: "1.5" })).toThrow();
  });

  test("rejects oversized inputs", () => {
    expect(() => parseReproInputs({ REPRO_SIZE_MB: String(MAX_TARGET_MB + 1) })).toThrow(/exceeds max/);
    expect(() => parseReproInputs({ REPRO_ROWS: String(MAX_ROWS + 1) })).toThrow(/exceeds max/);
  });

  test("rejects rows too large for size (payload < 1 byte)", () => {
    // 1 MiB / 1_000_000 rows -> < 1 byte per row after overhead.
    expect(() => parseReproInputs({ REPRO_SIZE_MB: "1", REPRO_ROWS: "1000000" })).toThrow(/too large/);
  });
});

describe("runWithCleanup — guaranteed cleanup on forced failure", () => {
  test("removes only the unique temp dir, preserves caller base, even on throw", () => {
    const base = mkdtempSync(join(tmpdir(), "repro-base-"));
    let capturedDir = "";
    expect(() =>
      runWithCleanup(base, (dir) => {
        capturedDir = dir;
        writeFileSync(join(dir, "artifact.txt"), "x");
        throw new Error("forced failure");
      }),
    ).toThrow("forced failure");

    // Unique dir gone, base preserved and empty of our prefix.
    expect(existsSync(capturedDir)).toBe(false);
    expect(existsSync(base)).toBe(true);
    expect(readdirSync(base).filter((n) => n.startsWith("filecache-repro-"))).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  test("closes registered DB on forced failure", () => {
    const base = mkdtempSync(join(tmpdir(), "repro-base-"));
    let dbRef: Database | null = null;
    expect(() =>
      runWithCleanup(base, (dir, registerDb) => {
        const db = new Database(join(dir, "f.sqlite"));
        registerDb(db);
        dbRef = db;
        db.exec("CREATE TABLE t (x)");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // DB was closed in finally: querying a closed handle throws.
    expect(dbRef).not.toBeNull();
    expect(() => (dbRef as unknown as Database).query("SELECT 1").all()).toThrow();
    expect(existsSync(base)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  test("returns fn result and cleans up on success", () => {
    const base = mkdtempSync(join(tmpdir(), "repro-base-"));
    let capturedDir = "";
    const out = runWithCleanup(base, (dir) => {
      capturedDir = dir;
      return 123;
    });
    expect(out).toBe(123);
    expect(existsSync(capturedDir)).toBe(false);
    expect(existsSync(base)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});
