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

  it("accepts same-origin client logs, tags source, and broadcasts through realtime publisher", async () => {
    vi.stubEnv("HOME", join(process.cwd(), ".tmp-internal-home"));
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    const { logger, routes } = await loadModules();
    const app = new Hono().route("/api/internal", routes.createInternalLogsRouter());
    const registry = new ChannelRegistry();
    const envelopes: unknown[] = [];

    registry.subscribe("system", { id: "system-client", send: (message) => envelopes.push(message) });
    logger.setRealtimePublisher(registry);
    logger.setDiskEnabled(false);

    const post = await app.request("http://localhost/api/internal/logs/client", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "ui.clicked", data: { pane: "logs" } }),
    });

    expect(post.status).toBe(200);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      channel: "system",
      event: "system:log",
      data: {
        component: "drawer",
        event: "ui.clicked",
        data: { pane: "logs", source: "dashboard-client" },
      },
    });

    const logs = await app.request("http://localhost/api/internal/logs?component=drawer&event=ui.clicked&limit=1", {
      headers: { host: "localhost:3000" },
    });

    expect(logs.status).toBe(200);
    await expect(logs.json()).resolves.toEqual([
      expect.objectContaining({
        component: "drawer",
        event: "ui.clicked",
        data: expect.objectContaining({ pane: "logs", source: "dashboard-client" }),
      }),
    ]);
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
