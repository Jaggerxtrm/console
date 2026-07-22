import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecialistFeed, MAX_SPECIALIST_FEED_OUTPUT_BYTES } from "../../../src/api/routes/specialists.ts";

// Regression for the post-window 2 GiB OOM (forge-wv9i.20.20.9): runSpecialistFeed
// accumulated child stdout/stderr with `stdout += chunk` and no byte cap (only a 10s
// timer), so a `specialists feed` child emitting a large log buffered gigabytes and
// OOM-killed the service. These tests fail before the byte-cap fix and pass after.

const OVER_CAP_BYTES = MAX_SPECIALIST_FEED_OUTPUT_BYTES * 16;

describe("runSpecialistFeed output byte bound", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "gitboard-feed-mem-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    delete process.env.GITBOARD_SPECIALISTS_BIN;
  });

  function writeFeed(script: string): void {
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "feed"), script);
    chmodSync(join(repoDir, "feed"), 0o755);
    process.env.GITBOARD_SPECIALISTS_BIN = "/bin/sh";
  }

  function payloadBytes(result: Awaited<ReturnType<typeof runSpecialistFeed>>): number {
    return Buffer.byteLength(result.ok ? result.text : result.error, "utf8");
  }

  it("bounds child stdout so an oversized feed cannot buffer unbounded memory", async () => {
    writeFeed(`yes | head -c ${OVER_CAP_BYTES}\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir });

    expect(result.ok).toBe(true);
    expect(payloadBytes(result)).toBeLessThanOrEqual(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("bounds child stderr so an oversized failing feed returns a bounded error", async () => {
    writeFeed(`yes | head -c ${OVER_CAP_BYTES} >&2\nexit 1\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir });

    expect(result.ok).toBe(false);
    expect(payloadBytes(result)).toBeLessThanOrEqual(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("keeps small feeds byte-identical (contract preserved)", async () => {
    writeFeed(`printf '%s\\n' "JOB:$1"\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir });

    expect(result).toEqual({ ok: true, text: "JOB:job-1\n" });
  });
});
