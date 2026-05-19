import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInternalLogsRouter } from "../../../src/api/routes/internal-logs.ts";
import { setRealtimePublisher, setDiskEnabled, emit } from "../../../src/core/logger.ts";
import { ChannelRegistry } from "../../../src/api/ws/channels.ts";

describe("internal logs route", () => {
  it("gates to localhost and filters logs", async () => {
    const router = createInternalLogsRouter();
    const app = new Hono().route("/api/internal", router);
    const registry = new ChannelRegistry();
    setRealtimePublisher(registry);
    setDiskEnabled(false);
    emit({ ts: "2026-05-19T00:00:00.000Z", level: "info", component: "api", event: "request.slow", msg: "slow", data: { ms: 501 } });
    const res = await app.request("http://localhost/api/internal/logs?level=info&component=api&event=request.slow&limit=1", { headers: { host: "localhost:3000" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].event).toBe("request.slow");
    const forbidden = await app.request("http://example.com/api/internal/logs", { headers: { host: "example.com" } });
    expect(forbidden.status).toBe(403);
  });
});
