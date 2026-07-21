import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { LOG_RING_SIZE, RealtimeChannelRegistry, type LogEntry } from "../src/runtime/index.ts";
import { createLoggerRuntime } from "../src/runtime/server.ts";

const tmpRoot = join(process.cwd(), ".tmp-runtime-logs");

function entry(ts: string, level: LogEntry["level"], event: string): LogEntry {
  return { ts, level, component: "system", event };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("logger runtime", () => {
  it("keeps newest entries in overflow order", () => {
    const logger = createLoggerRuntime({ diskDir: join(tmpRoot, "logs"), ringSize: 3 });
    logger.setDiskEnabled(false);

    logger.emit(entry("1", "info", "one"));
    logger.emit(entry("2", "info", "two"));
    logger.emit(entry("3", "info", "three"));
    logger.emit(entry("4", "info", "four"));

    expect(logger.getRing().map((item) => item.event)).toEqual(["two", "three", "four"]);
  });

  it("publishes only entries at configured level", () => {
    const published: LogEntry[] = [];
    const logger = createLoggerRuntime({ diskDir: join(tmpRoot, "logs"), publisher: (item) => published.push(item) });
    logger.setDiskEnabled(false);
    logger.setLogLevel("warn");

    logger.emit(entry("1", "info", "info"));
    logger.emit(entry("2", "warn", "warn"));
    logger.emit(entry("3", "error", "error"));

    expect(published.map((item) => item.event)).toEqual(["warn", "error"]);
  });

  it("applies subscription filters and unsubscribe", () => {
    const logger = createLoggerRuntime({ diskDir: join(tmpRoot, "logs") });
    const received: string[] = [];
    logger.setDiskEnabled(false);

    const unsubscribe = logger.subscribe({ level: "warn", component: "system", event: "match" }, (item) => received.push(item.event));
    logger.emit(entry("1", "info", "match"));
    logger.emit(entry("2", "warn", "other"));
    logger.emit(entry("3", "warn", "match"));
    unsubscribe();
    logger.emit(entry("4", "warn", "match"));

    expect(received).toEqual(["match"]);
  });

  it("writes disk files and removes expired jsonl files", async () => {
    const dir = join(tmpRoot, "logs");
    await mkdir(dir, { recursive: true });
    const oldFile = join(dir, "2026-05-01.jsonl");
    await writeFile(oldFile, "{}\n");
    utimesSync(oldFile, new Date("2026-05-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));
    const logger = createLoggerRuntime({ diskDir: dir, retentionDays: 7 });
    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "hello"));
    await logger.flush();

    const current = join(dir, "2026-05-19.jsonl");
    expect(existsSync(current)).toBe(true);
    expect(await readFile(current, "utf8")).toContain('"event":"hello"');
    expect(existsSync(oldFile)).toBe(false);
  });

  it("flush waits for every queued disk write", async () => {
    const dir = join(tmpRoot, "queued");
    const logger = createLoggerRuntime({ diskDir: dir });

    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "first"));
    logger.emit(entry("2026-05-19T00:00:01.000Z", "warn", "second"));
    await logger.flush();

    expect((await readFile(join(dir, "2026-05-19.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).event)).toEqual(["first", "second"]);
  });

  it("does not fall back to cwd logs when storage init fails", async () => {
    const blockedParent = join(tmpRoot, "blocked-parent");
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(blockedParent, "not a directory");
    await rm(join(process.cwd(), "logs"), { recursive: true, force: true });
    const errors: unknown[] = [];
    const logger = createLoggerRuntime({ diskDir: join(blockedParent, "logs"), onWriteError: (error) => errors.push(error) });

    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "hello"));
    await logger.flush();

    expect(errors).toHaveLength(1);
    expect(existsSync(join(process.cwd(), "logs"))).toBe(false);
  });

  it("skips symlinks during retention cleanup", async () => {
    const dir = join(tmpRoot, "symlink-logs");
    const targetDir = join(tmpRoot, "outside");
    await mkdir(dir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, "target.jsonl");
    const link = join(dir, "2026-05-01.jsonl");
    await writeFile(target, "outside\n");
    symlinkSync(target, link);
    const logger = createLoggerRuntime({ diskDir: dir, retentionDays: 7 });

    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "hello"));
    await logger.flush();

    expect(existsSync(link)).toBe(true);
    expect(await readFile(target, "utf8")).toBe("outside\n");
  });

  it("skips disk writes when disabled", async () => {
    const dir = join(tmpRoot, "disabled");
    const logger = createLoggerRuntime({ diskDir: dir });
    logger.setDiskEnabled(false);

    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "hello"));
    await logger.flush();

    expect(existsSync(dir)).toBe(false);
    expect(logger.getRing()).toHaveLength(1);
  });

  it("uses default ring size constant", () => {
    const logger = createLoggerRuntime({ diskDir: join(tmpRoot, "logs") });
    logger.setDiskEnabled(false);

    for (let i = 0; i < LOG_RING_SIZE + 1; i += 1) logger.emit(entry(`${i}`, "info", `e${i}`));

    expect(logger.getRing()).toHaveLength(LOG_RING_SIZE);
    expect(logger.getRing()[0].event).toBe("e1");
  });

  it("publishes append events through realtime registry", () => {
    const registry = new RealtimeChannelRegistry();
    const sent: unknown[] = [];
    registry.subscribe("system", { id: "system-client", send: (message) => sent.push(message) });
    const logger = createLoggerRuntime({
      diskDir: join(tmpRoot, "logs"),
      publisher: (item) => registry.publish("system", "system:log", item, item.ts),
    });
    logger.setDiskEnabled(false);

    logger.emit(entry("2026-05-19T00:00:00.000Z", "info", "hello"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "system", event: "system:log", version: "2026-05-19T00:00:00.000Z", data: { event: "hello" } });
  });
});
