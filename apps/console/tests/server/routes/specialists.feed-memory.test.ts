import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecialistFeed, MAX_SPECIALIST_FEED_OUTPUT_BYTES } from "../../../src/server/routes/specialists.ts";

// Regression for post-window 2 GiB OOM (forge-wv9i.20.20.9): runSpecialistFeed
// accumulated child stdout/stderr with `stdout += chunk` and no byte cap (only a 10s
// timer), so large specialist logs could buffer gigabytes and kill gitboard.service.
// Overflow contract is bounded prefix with ok:true, not a tail. Overflow assertions
// fail before byte-cap fix and pass after it.

const OVER_CAP_BYTES = MAX_SPECIALIST_FEED_OUTPUT_BYTES + 64 * 1024;
const CHILD_EXIT_POLL_MS = 25;
const CHILD_EXIT_POLL_ATTEMPTS = 40;

describe("runSpecialistFeed lifecycle and output byte bound", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "gitboard-feed-memory-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  function writeFeed(script: string, command = "/bin/sh", fileName = "feed"): NodeJS.ProcessEnv {
    const feedPath = join(repoDir, fileName);
    writeFileSync(feedPath, script);
    chmodSync(feedPath, 0o755);
    return { ...process.env, GITBOARD_SPECIALISTS_BIN: command };
  }

  function writeNodeFeed(script: string): NodeJS.ProcessEnv {
    return writeFeed(script, process.execPath);
  }

  function payloadBytes(result: Awaited<ReturnType<typeof runSpecialistFeed>>): number {
    return Buffer.byteLength(result.ok ? result.text : result.error, "utf8");
  }

  async function childExited(pidFile: string): Promise<boolean> {
    const pid = Number(await readFile(pidFile, "utf8"));
    for (let attempt = 0; attempt < CHILD_EXIT_POLL_ATTEMPTS; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, CHILD_EXIT_POLL_MS));
    }
    return false;
  }

  it("preserves exact-cap stdout bytes and successful status", async () => {
    const env = writeNodeFeed(`process.stdout.write("A".repeat(${MAX_SPECIALIST_FEED_OUTPUT_BYTES}));\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result.ok).toBe(true);
    expect(payloadBytes(result)).toBe(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("counts exact-cap multibyte stdout by UTF-8 bytes", async () => {
    const env = writeNodeFeed(`process.stdout.write("é".repeat(${MAX_SPECIALIST_FEED_OUTPUT_BYTES / 2}));\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result.ok).toBe(true);
    expect(payloadBytes(result)).toBe(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("returns bounded stdout prefix with ok:true after overflow", async () => {
    const env = writeNodeFeed(`process.stdout.write("PREFIX:" + "A".repeat(${OVER_CAP_BYTES}));\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text.startsWith("PREFIX:")).toBe(true);
    expect(payloadBytes(result)).toBeLessThanOrEqual(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("bounds oversized stderr while preserving failing status", async () => {
    const env = writeNodeFeed(`process.stderr.write("ERROR-PREFIX:" + "E".repeat(${OVER_CAP_BYTES})); process.exitCode = 1;\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual(expect.objectContaining({ ok: false, status: 500 }));
    if (!result.ok) expect(result.error.startsWith("ERROR-PREFIX:")).toBe(true);
    expect(payloadBytes(result)).toBeLessThanOrEqual(MAX_SPECIALIST_FEED_OUTPUT_BYTES);
  });

  it("maps nonzero not-found output to 404", async () => {
    const env = writeNodeFeed(`process.stderr.write("specialist feed: job not found\\n"); process.exitCode = 1;\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: false, status: 404, error: "specialist feed: job not found" });
  });

  it("keeps ordinary nonzero exit at bounded 500 error contract", async () => {
    const env = writeNodeFeed(`process.stderr.write("specialist failed\\n"); process.exitCode = 7;\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: false, status: 500, error: "specialist failed" });
  });

  it("settles spawn error with 500 and clears timer", async () => {
    const result = await runSpecialistFeed("job-1", {
      cwd: repoDir,
      env: { ...process.env, GITBOARD_SPECIALISTS_BIN: join(repoDir, "missing-specialists") },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toMatch(/ENOENT|not found/i);
    }
  });

  it("settles timeout once and reaps direct child", async () => {
    const pidFile = join(repoDir, "feed.pid");
    const env = writeNodeFeed(`require("node:fs").writeFileSync(process.env.FEED_PID_FILE, String(process.pid)); setTimeout(() => {}, 30000);\n`);
    env.FEED_PID_FILE = pidFile;

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: false, status: 500, error: "specialist feed timed out" });
    expect(await childExited(pidFile)).toBe(true);
  }, 15_000);

  it("preserves small feed text and argument contract", async () => {
    const env = writeFeed(`printf '%s\\n' "JOB:$1"\n`);

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: true, text: "JOB:job-1\n" });
  });

  // Regression for F-001 (audit f990ed): timeout sent SIGTERM to the direct child
  // only and settled immediately, so a SIGTERM-resistant child survived the HTTP
  // response. Timeout must escalate TERM->KILL and reap the direct child before
  // settling. Fails before the fix (child survives) and passes after it.
  it("reaps a SIGTERM-ignoring child via bounded TERM-to-KILL escalation", async () => {
    const pidFile = join(repoDir, "feed.pid");
    const env = writeNodeFeed(
      `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.FEED_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    env.FEED_PID_FILE = pidFile;

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: false, status: 500, error: "specialist feed timed out" });
    expect(await childExited(pidFile)).toBe(true);
  }, 20_000);

  it("kills inherited-stdio descendant via process-group cleanup and settles once", async () => {
    const pidFile = join(repoDir, "feed.pid");
    const descPidFile = join(repoDir, "desc.pid");
    const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.DESC_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`;
    const env = writeNodeFeed(
      `const { spawn } = require("node:child_process");
       spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" });
       require("node:fs").writeFileSync(process.env.FEED_PID_FILE, String(process.pid));
       process.on("SIGTERM", () => {});
       setInterval(() => {}, 1000);\n`,
    );
    env.FEED_PID_FILE = pidFile;
    env.DESC_PID_FILE = descPidFile;

    const result = await runSpecialistFeed("job-1", { cwd: repoDir, env });

    expect(result).toEqual({ ok: false, status: 500, error: "specialist feed timed out" });
    expect(await childExited(pidFile)).toBe(true);
    expect(await childExited(descPidFile)).toBe(true);
  }, 20_000);
});
