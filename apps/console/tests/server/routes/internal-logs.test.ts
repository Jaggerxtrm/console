import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createLoggerRuntime } from "../../../../../packages/core/src/runtime/log-store.ts";
import { createInternalLogsRouter } from "../../../src/server/routes/internal-logs.ts";

async function loadModules() {
  const home = process.env.HOME ?? process.cwd();
  const diskDir = process.env.LOG_DIR?.trim() || process.env.GITBOARD_LOG_DIR?.trim() || join(home, ".xtrm", "logs");
  const logger = createLoggerRuntime({ diskDir });
  logger.setDiskEnabled(false);
  return { logger };
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
    const { logger } = await loadModules();
    const app = new Hono().route("/api/internal", createInternalLogsRouter(logger));

    logger.emit({ ts: "2026-05-19T00:00:00.000Z", level: "info", component: "api", event: "request.slow", msg: "slow", data: { ms: 501 } });
    logger.emit({ ts: "2026-05-19T00:00:01.000Z", level: "info", component: "api", event: "request.slow", msg: "slower", data: { ms: 777 } });

    const res = await app.request("http://localhost:3000/api/internal/logs?level=info&component=api&event=request.slow&since=2026-05-19T00:00:00.500Z&limit=1", { headers: { host: "localhost:3000" } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].event).toBe("request.slow");
    expect(body[0].msg).toBe("slower");

    const forbidden = await app.request("http://example.com/api/internal/logs", { headers: { host: "example.com" } });
    expect(forbidden.status).toBe(403);

    const forgedHost = await app.request("http://example.com/api/internal/logs", { headers: { host: "localhost:3000" } });
    expect(forgedHost.status).toBe(403);

    const negativeLimit = await app.request("http://localhost:3000/api/internal/logs?limit=-1", { headers: { host: "localhost:3000" } });
    expect(await negativeLimit.json()).toHaveLength(1);
  });

  it("bounds and redacts client log payloads", async () => {
    vi.stubEnv("HOME", join(process.cwd(), ".tmp-internal-home"));
    const { logger } = await loadModules();
    const app = new Hono().route("/api/internal", createInternalLogsRouter(logger));

    const accepted = await app.request("http://localhost:3000/api/internal/logs/client", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ event: "ui.security", data: { token: "secret", cwd: "/home/dawid/private", nested: { authorization: "Bearer secret" } } }),
    });
    expect(accepted.status).toBe(200);
    const [entry] = logger.getRing();
    expect(entry?.data).toMatchObject({ token: "[REDACTED]", cwd: "[REDACTED_PATH]", nested: { authorization: "[REDACTED]" } });
    expect(JSON.stringify(entry)).not.toContain("dawid");
    expect(JSON.stringify(entry)).not.toContain("Bearer secret");

    const oversized = await app.request("http://localhost:3000/api/internal/logs/client", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ event: "ui.large", data: { value: "x".repeat(70_000) } }),
    });
    expect(oversized.status).toBe(413);
  });

  it("accepts same-origin client logs, tags source, and broadcasts through realtime publisher", async () => {
    vi.stubEnv("HOME", join(process.cwd(), ".tmp-internal-home"));
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    const { logger } = await loadModules();
    const app = new Hono().route("/api/internal", createInternalLogsRouter(logger));
    const envelopes: unknown[] = [];

    logger.setRealtimePublisher((entry) => envelopes.push({
      channel: "system",
      event: "system:log",
      data: entry,
    }));

    const post = await app.request("http://localhost:3000/api/internal/logs/client", {
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

    const logs = await app.request("http://localhost:3000/api/internal/logs?component=drawer&event=ui.clicked&limit=1", {
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

  it("rejects client log writes without same-origin proof or an internal logs token", async () => {
    vi.stubEnv("HOME", join(process.cwd(), ".tmp-internal-home"));
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    vi.stubEnv("GITBOARD_INTERNAL_LOGS_TOKEN", "secret");
    const { logger } = await loadModules();
    const app = new Hono().route("/api/internal", createInternalLogsRouter(logger));

    const missingOrigin = await app.request("http://localhost:3000/api/internal/logs/client", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "ui.clicked" }),
    });
    expect(missingOrigin.status).toBe(403);

    const forgedHost = await app.request("http://example.com/api/internal/logs/client", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "ui.clicked" }),
    });
    expect(forgedHost.status).toBe(403);

    const token = await app.request("http://example.com/api/internal/logs/client", {
      method: "POST",
      headers: {
        host: "example.com",
        "x-gitboard-internal-logs-token": "secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "ui.clicked" }),
    });
    expect(token.status).toBe(200);
  });

  it("lists jsonl files for localhost callers", async () => {
    const home = join(process.cwd(), ".tmp-internal-home");
    const dir = join(home, ".xtrm", "logs");
    vi.stubEnv("HOME", home);
    vi.stubEnv("LOG_DIR", "");
    vi.stubEnv("GITBOARD_LOG_DIR", "");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-05-19.jsonl"), '{"event":"hello"}\n');
    const { logger } = await loadModules();
    const app = new Hono().route("/api/internal", createInternalLogsRouter(logger));

    const res = await app.request("http://localhost:3000/api/internal/logs/files", { headers: { host: "localhost:3000" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "2026-05-19.jsonl", size: 18, date: "2026-05-19" }]);

    const forgedHost = await app.request("http://example.com/api/internal/logs/files", { headers: { host: "localhost:3000" } });
    expect(forgedHost.status).toBe(403);
  });
});
