import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "../../src/core/observability/verifier.ts";

describe("observability smoke", () => {
  it("matches seeded percentiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "obs-smoke-"));
    const lines: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const duration = i % 3 === 0 ? 10 : i % 3 === 1 ? 20 : 30;
      lines.push(JSON.stringify({ ts: "2026-05-24T00:00:00.000Z", level: "info", component: ["materializer", "parity", "api"][i % 3], event: ["run", "diff", "request"][i % 3], data: { duration_ms: duration, outcome: "ok" } }));
    }
    lines.push(JSON.stringify({ ts: "2026-05-24T00:00:00.000Z", level: "error", component: "api", event: "request", data: { duration_ms: 40, outcome: "error" } }));
    await writeFile(join(dir, "2026-05-24.jsonl"), lines.join("\n") + "\n");
    const body = await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "2026-05-24.jsonl"), "utf8"));
    const entries = body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = summarize(entries, []);
    expect(result.p95_ms).toBe(30);
    expect(result.breaches).toHaveLength(0);
    expect(result.error_count).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});
