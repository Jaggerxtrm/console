import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, utimesSync } from "node:fs";
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
    expect(existsSync(join(dir, "2026-05-01.jsonl"))).toBe(false);
  });
});
