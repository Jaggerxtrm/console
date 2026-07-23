import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { createInternalVerifyRouter } from "../../../src/server/routes/internal-verify.ts";

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
    const events: LogEntry[] = [];

    try {
      const router = createInternalVerifyRouter({ emit: (entry) => events.push(entry) });
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
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid or excessively broad intervals", async () => {
    const app = new Hono().route("/api/internal", createInternalVerifyRouter());
    const headers = { host: "localhost:3000" };

    const invalid = await app.request("http://localhost/api/internal/verify-runtime?since=nope&until=2026-05-24T00:00:00.000Z", { headers });
    const reversed = await app.request("http://localhost/api/internal/verify-runtime?since=2026-05-25T00:00:00.000Z&until=2026-05-24T00:00:00.000Z", { headers });
    const tooWide = await app.request("http://localhost/api/internal/verify-runtime?since=2026-05-01T00:00:00.000Z&until=2026-05-24T00:00:00.000Z", { headers });

    expect(invalid.status).toBe(400);
    expect(reversed.status).toBe(400);
    expect(tooWide.status).toBe(400);
  });

  it("allows only one verifier scan per router at a time", async () => {
    let release!: (value: VerificationFixture) => void;
    const pending = new Promise<VerificationFixture>((resolve) => { release = resolve; });
    const app = new Hono().route("/api/internal", createInternalVerifyRouter({ verify: () => pending }));
    const request = () => app.request("http://localhost/api/internal/verify-runtime?since=2026-05-24T00:00:00.000Z&until=2026-05-24T00:01:00.000Z", {
      headers: { host: "localhost:3000" },
    });

    const first = request();
    await Promise.resolve();
    const concurrent = await request();
    expect(concurrent.status).toBe(429);

    release(emptyVerification());
    expect((await first).status).toBe(200);
    expect((await request()).status).toBe(200);
  });
});

type VerificationFixture = {
  by_component: Record<string, never>;
  by_event: Record<string, never>;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  breaches: never[];
};

function emptyVerification(): VerificationFixture {
  return { by_component: {}, by_event: {}, error_count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, breaches: [] };
}
