import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verifier, type VerifierMetrics } from "../src/runtime/verifier.ts";

describe("runtime verifier", () => {
  it("prunes daily files before opening them and bounds duration samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-verifier-"));
    const entry = (index: number) => JSON.stringify({
      ts: `2026-05-24T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      level: "info",
      component: "api",
      event: "request",
      data: { duration_ms: index, outcome: "ok" },
    });
    await Promise.all([
      writeFile(join(dir, "2026-05-23.jsonl"), "not-json\n"),
      writeFile(join(dir, "2026-05-25.jsonl"), "not-json\n"),
      writeFile(join(dir, "2026-05-24.jsonl"), `not-json\n${Array.from({ length: 10_000 }, (_, index) => entry(index)).join("\n")}\n`),
    ]);
    const metrics: VerifierMetrics[] = [];

    try {
      const result = await new Verifier({ dir, onMetrics: (value) => metrics.push(value) }).verify(
        "2026-05-24T00:00:00.000Z",
        "2026-05-24T02:46:39.000Z",
      );

      expect(result.by_event["api.request"].count).toBe(10_000);
      expect(result.by_event["api.request"].durations_ms.length).toBeLessThanOrEqual(4096);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ files_opened: 1, files_pruned: 2, lines_scanned: 10_001, malformed_lines: 1, file_errors: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
