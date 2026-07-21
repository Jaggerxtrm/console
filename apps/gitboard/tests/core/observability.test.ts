import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logger from "../../src/core/logger.ts";
import type { LogEntry } from "../../src/types/log.ts";
import { correlate, withSpan } from "../../src/core/observability/spans.ts";
import { Verifier, summarize } from "../../src/core/observability/verifier.ts";
import { createInternalVerifyRouter } from "../../src/api/routes/internal-verify.ts";
import { Hono } from "hono";

describe("observability spans", () => {
  it("emits exactly one event on success and throw", async () => {
    logger.setDiskEnabled(false);
    const entries: LogEntry[] = [];
    const unsubscribe = logger.subscribe(undefined, (entry) => entries.push(entry));
    await expect(withSpan("api", "request.test" as never, {}, async () => 42)).resolves.toBe(42);
    expect(entries).toHaveLength(1);
    expect(entries[0].data?.outcome).toBe("ok");
    entries.length = 0;
    await expect(withSpan("api", "request.test" as never, {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(entries).toHaveLength(1);
    expect(entries[0].data?.outcome).toBe("error");
    expect(entries[0].data?.error_message).toBe("boom");
    unsubscribe();
  });

  it("propagates correlation id through awaits", async () => {
    logger.setDiskEnabled(false);
    const entries: LogEntry[] = [];
    const unsubscribe = logger.subscribe(undefined, (entry) => entries.push(entry));
    await correlate("job-123", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await withSpan("materializer", "run" as never, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    });
    expect(entries[0].data?.correlation_id).toBe("job-123");
    unsubscribe();
  });
});

describe("observability verifier", () => {
  it("aggregates durations and breaches thresholds", () => {
    const entries = [
      { ts: "2026-05-24T00:00:00.000Z", level: "info", component: "api", event: "request", data: { duration_ms: 100, outcome: "ok" } },
      { ts: "2026-05-24T00:00:01.000Z", level: "info", component: "api", event: "request", data: { duration_ms: 250, outcome: "ok" } },
      { ts: "2026-05-24T00:00:02.000Z", level: "error", component: "api", event: "request", data: { duration_ms: 300, outcome: "error", error_message: "x" } },
    ] as const;
    const result = summarize(entries, [{ component: "api", event: "request", p95_ms: 200, severity: "medium" }]);
    expect(result.by_component.api.count).toBe(3);
    expect(result.error_count).toBe(1);
    expect(result.breaches).toHaveLength(1);
  });

  it("reads jsonl files and verifies route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "obs-"));
    const logs = join(dir, "2026-05-24.jsonl");
    await writeFile(logs, [
      JSON.stringify({ ts: "2026-05-24T00:00:00.000Z", level: "info", component: "api", event: "request", data: { duration_ms: 10, outcome: "ok" } }),
      JSON.stringify({ ts: "2026-05-24T00:00:01.000Z", level: "error", component: "api", event: "request", data: { duration_ms: 20, outcome: "error" } }),
    ].join("\n") + "\n");
    const verifier = new Verifier({ dir });
    const result = await verifier.verify("2026-05-24T00:00:00.000Z", "2026-05-24T00:10:00.000Z");
    expect(result.error_count).toBe(1);
    const router = createInternalVerifyRouter();
    const app = new Hono().route("/api/internal", router);
    const res = await app.request("http://localhost/api/internal/verify-runtime?since=2026-05-24T00:00:00.000Z&until=2026-05-24T00:10:00.000Z", { headers: { host: "localhost:3000" } });
    expect(res.status).toBe(200);
    await rm(dir, { recursive: true, force: true });
  });
});
