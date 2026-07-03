import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ChannelRegistry } from "../../src/api/ws/channels.ts";

async function loadLogger() {
  vi.resetModules();
  return await import("../../src/core/logger.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logger", () => {
  it("keeps ring overflow newest entries", async () => {
    const logger = await loadLogger();
    logger.setDiskEnabled(false);
    for (let i = 0; i < logger.LOG_RING_SIZE + 2; i += 1) {
      logger.emit({ ts: `${i}`, level: "info", component: "system", event: `e${i}` });
    }
    expect(logger.getRing()).toHaveLength(logger.LOG_RING_SIZE);
    expect(logger.getRing()[0].event).toBe("e2");
  });

  it("broadcasts only entries at configured level", async () => {
    const logger = await loadLogger();
    logger.setDiskEnabled(false);
    logger.setLogLevel("warn");
    const registry = new ChannelRegistry();
    logger.setRealtimePublisher(registry);
    const sent: unknown[] = [];
    registry.subscribe("system", { id: "s1", send: (msg) => sent.push(msg) });
    logger.emit({ ts: "1", level: "info", component: "system", event: "info" });
    logger.emit({ ts: "2", level: "warn", component: "system", event: "warn" });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { event: string }).event).toBe("system:log");
  });

  it("uses env override before xtrm default and creates legacy symlink", async () => {
    const home = join(process.cwd(), ".tmp-home");
    const legacyDir = join(home, ".agent-forge", "logs");
    const defaultDir = join(home, ".xtrm", "logs");
    await rm(home, { recursive: true, force: true });
    await mkdir(legacyDir, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    const logger = await loadLogger();
    expect(logger.getLogDiskDir()).toBe(defaultDir);
    expect(logger.ensureLogStorage()).toBe(defaultDir);
    expect(lstatSync(join(defaultDir, "legacy")).isSymbolicLink()).toBe(true);
  });

  it("normalizes relative env log dirs to absolute paths", async () => {
    vi.stubEnv("LOG_DIR", ".tmp-relative-logs");
    const logger = await loadLogger();
    logger.setDiskEnabled(false);

    expect(logger.getLogDiskDir()).toBe(join(process.cwd(), ".tmp-relative-logs"));
  });

  it("keeps wrapper subscribe filter compatibility", async () => {
    const logger = await loadLogger();
    logger.setDiskEnabled(false);
    const received: string[] = [];

    const unsubscribe = logger.subscribe({ level: "warn", component: "system", event: "match" }, (entry) => received.push(entry.event));
    logger.emit({ ts: "1", level: "info", component: "system", event: "match" });
    logger.emit({ ts: "2", level: "warn", component: "api", event: "match" });
    logger.emit({ ts: "3", level: "warn", component: "system", event: "match" });
    unsubscribe();
    logger.emit({ ts: "4", level: "warn", component: "system", event: "match" });

    expect(received).toEqual(["match"]);
  });

  it("emits log.path entry through wrapper helpers", async () => {
    const dir = join(process.cwd(), ".tmp-wrapper-logs");
    await rm(dir, { recursive: true, force: true });
    vi.stubEnv("LOG_DIR", dir);
    const logger = await loadLogger();
    logger.setDiskEnabled(false);

    logger.emitLogPath();

    expect(logger.ensureLogStorage()).toBe(dir);
    expect(logger.getRing().at(-1)).toMatchObject({ component: "logger", event: "log.path", level: "info", data: { path: dir } });
  });

  it("writes disk and removes old files", async () => {
    const dir = join(process.cwd(), ".tmp-logs");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const day of ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08"]) {
      const file = join(dir, `${day}.jsonl`);
      await writeFile(file, "{}\n");
      utimesSync(file, new Date("2026-05-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));
    }
    vi.stubEnv("LOG_DIR", dir);
    vi.stubEnv("LOG_RETENTION_DAYS", "7");
    const logger = await loadLogger();
    logger.setDiskEnabled(true);
    logger.emit({ ts: "2026-05-19T00:00:00.000Z", level: "info", component: "system", event: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(join(dir, "2026-05-19.jsonl"))).toBe(true);
    expect(await readFile(join(dir, "2026-05-19.jsonl"), "utf8")).toContain('"event":"hello"');
    expect(existsSync(join(dir, "2026-05-01.jsonl"))).toBe(false);
  });
});
