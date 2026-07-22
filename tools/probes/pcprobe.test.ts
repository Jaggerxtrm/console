import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HERE = dirname(import.meta.path);
const SRC = join(HERE, "pcprobe.c");

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pcprobe-test-"));
  bin = join(work, "pcprobe");
  // Compile with warnings-as-errors; this is itself a regression gate.
  const cc = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", "-o", bin, SRC], { encoding: "utf8" });
  if (cc.status !== 0) throw new Error(`compile failed:\n${cc.stderr}`);
});

function run(mode: string, path: string) {
  return spawnSync(bin, [mode, path], { encoding: "utf8" });
}

describe("pcprobe source guards (read-only honesty + accurate fadvise)", () => {
  const src = readFileSync(SRC, "utf8");
  test("opens O_RDONLY and no open() call uses O_RDWR", () => {
    expect(src).toMatch(/open\(path,\s*O_RDONLY\)/);
    // No open() call may request write access (comments aside).
    expect(src).not.toMatch(/open\([^)]*O_RDWR/);
  });
  test("reports posix_fadvise via strerror(ret), not perror", () => {
    expect(src).toContain("strerror(adv)");
    expect(src).not.toContain('perror("posix_fadvise")');
  });
});

describe("pcprobe behavior", () => {
  test("evict succeeds on a read-only (0444) file — O_RDONLY only", () => {
    const p = join(work, "readonly.bin");
    writeFileSync(p, Buffer.alloc(8192, 7));
    chmodSync(p, 0o444);
    const r = run("evict", p);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.evicted).toBe(true);
    expect(j.total_bytes).toBe(8192);
  });

  test("stat emits valid JSON for a path with quotes and backslashes", () => {
    const weird = join(work, 'we"ird\\na\tme.db');
    writeFileSync(weird, Buffer.alloc(4096, 1));
    const r = run("stat", weird);
    expect(r.status).toBe(0);
    // Must parse as JSON (old unescaped output would throw here).
    const j = JSON.parse(r.stdout.trim());
    expect(j.path).toBe(weird);
    expect(j.total_bytes).toBe(4096);
    expect(typeof j.resident_bytes).toBe("number");
    expect(typeof j.pct).toBe("number");
  });

  test("evict emits valid JSON for an arbitrary path", () => {
    const weird = join(work, 'ev"ict\\me.db');
    writeFileSync(weird, Buffer.alloc(4096, 2));
    const r = run("evict", weird);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout.trim());
    expect(j.path).toBe(weird);
    expect(j.evicted).toBe(true);
  });

  test("mincore math: resident never exceeds total; pct sane", () => {
    const p = join(work, "math.bin");
    writeFileSync(p, Buffer.alloc(16384, 3));
    const j = JSON.parse(run("stat", p).stdout.trim());
    expect(j.resident_bytes).toBeLessThanOrEqual(j.total_bytes);
    expect(j.pct).toBeGreaterThanOrEqual(0);
    expect(j.pct).toBeLessThanOrEqual(100);
  });

  test("empty file short-circuits with valid JSON", () => {
    const p = join(work, "empty.bin");
    writeFileSync(p, Buffer.alloc(0));
    const j = JSON.parse(run("stat", p).stdout.trim());
    expect(j.total_bytes).toBe(0);
    expect(j.resident_bytes).toBe(0);
  });

  test("missing path fails non-zero", () => {
    const r = run("stat", join(work, "does-not-exist"));
    expect(r.status).toBe(1);
  });
});

// Cleanup the scratch dir after the suite process exits.
process.on("exit", () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
