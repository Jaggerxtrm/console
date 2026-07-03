import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { ChannelRegistry } from "../../../src/api/ws/channels.ts";

async function loadModules() {
  vi.resetModules();
  const logger = await import("../../../src/core/logger.ts");
  const routes = await import("../../../src/api/routes/internal-logs.ts");
  return { logger, routes };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(join(process.cwd(), ".tmp-internal-home"), { recursive: true, force: true });
});

describe("internal logs route", () => {
  it("gates to localhost and filters logs with since/limit compatibility", async () => {
    vi.stubEnv("HOME", join(process.cwd(), ".tmp-internal-home"));
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    const { logger, routes } = await loadModules();
    const app = new Hono().route("/api/internal", routes.createInternalLogsRouter());
    const registry = new ChannelRegistry();

    logger.setRealtimePublisher(registry);
    logger.setDiskEnabled(false);
    logger.emit({ ts: "2026-05-19T00:00:00.000Z", level: "info", component: "api", event: "request.slow", msg: "slow", data: { ms: 501 } });
    logger.emit({ ts: "2026-05-19T00:00:01.000Z", level: "info", component: "api", event: "request.slow", msg: "slower", data: { ms: 777 } });

    const res = await app.request("http://localhost/api/internal/logs?level=info&component=api&event=request.slow&since=2026-05-19T00:00:00.500Z&limit=1", { headers: { host: "localhost:3000" } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].event).toBe("request.slow");
    expect(body[0].msg).toBe("slower");

    const forbidden = await app.request("http://example.com/api/internal/logs", { headers: { host: "example.com" } });
    expect(forbidden.status).toBe(403);
  });

  it("lists jsonl files for localhost callers", async () => {
    const home = join(process.cwd(), ".tmp-internal-home");
    const dir = join(home, ".xtrm", "logs");
    vi.stubEnv("HOME", home);
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-05-19.jsonl"), '{"event":"hello"}\n');
    const { routes } = await loadModules();
    const app = new Hono().route("/api/internal", routes.createInternalLogsRouter());

    const res = await app.request("http://localhost/api/internal/logs/files", { headers: { host: "localhost:3000" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "2026-05-19.jsonl", size: 18, date: "2026-05-19" }]);
  });
});
