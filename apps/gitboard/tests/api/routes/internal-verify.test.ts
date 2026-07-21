import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as logger from "../../../src/core/logger.ts";
import { createInternalVerifyRouter } from "../../../src/api/routes/internal-verify.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("internal verify route", () => {
  it("gates to localhost", async () => {
    const router = createInternalVerifyRouter();
    const app = new Hono().route("/api/internal", router);
    const res = await app.request("http://example.com/api/internal/verify-runtime", { headers: { host: "example.com" } });
    expect(res.status).toBe(403);
  });

  it("serves localhost requests and emits verifier metrics telemetry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "internal-verify-route-"));
    vi.stubEnv("LOG_DIR", dir);
    logger.setDiskEnabled(false);
    const events: Array<{ component: string; event: string; data?: Record<string, unknown> }> = [];
    const unsubscribe = logger.subscribe(undefined, (entry) => events.push(entry));

    try {
      const router = createInternalVerifyRouter();
      const app = new Hono().route("/api/internal", router);
      const res = await app.request("http://localhost/api/internal/verify-runtime?since=2026-05-24T00:00:00.000Z&until=2026-05-24T00:01:00.000Z", {
        headers: { host: "localhost:3000" },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ error_count: 0, by_component: {}, by_event: {} });
      expect(events).toContainEqual(expect.objectContaining({
        component: "api",
        event: "verify-runtime",
        data: expect.objectContaining({ files_seen: 0, files_opened: 0, files_pruned: 0, lines_scanned: 0, malformed_lines: 0, file_errors: 0, error_count: 0 }),
      }));
    } finally {
      unsubscribe();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
