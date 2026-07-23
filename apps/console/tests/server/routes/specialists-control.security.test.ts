import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSpecialistsControlRouter, runSpecialistCommand } from "../../../src/server/routes/specialists-control.ts";
import type { SpecialistJob } from "../../../src/types/specialists.ts";

const originalToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
let tempDirs: string[] = [];

beforeEach(() => {
  process.env.CONSOLE_WRITE_ADMIN_TOKEN = "secret";
});

afterEach(async () => {
  if (originalToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalToken;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("specialists control security", () => {
  it("refuses control targets that are not a contained FIFO", async () => {
    const repo = await createRepoControlFixture();
    const regularFile = join(repo, ".specialists", "jobs", "job-1", "control.pipe");
    await writeFile(regularFile, "unchanged");
    await writeFile(join(repo, ".specialists", "jobs", "job-1", "status.json"), JSON.stringify({ fifo_path: regularFile }));
    const app = controlApp(repo);

    const response = await app.request(controlRequest());

    expect(response.status).toBe(500);
    expect(await readFile(regularFile, "utf8")).toBe("unchanged");
  });

  it("fails promptly when a valid FIFO has no reader", async () => {
    const repo = await createRepoControlFixture();
    const fifo = join(repo, ".specialists", "jobs", "job-1", "control.pipe");
    execFileSync("mkfifo", [fifo]);
    await writeFile(join(repo, ".specialists", "jobs", "job-1", "status.json"), JSON.stringify({ fifo_path: fifo }));
    const app = controlApp(repo);
    const started = performance.now();

    const response = await app.request(controlRequest());

    expect(response.status).toBe(500);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("kills and reaps the complete command process group after timeout", async () => {
    const dir = await makeTempDir("console-control-timeout-");
    const childPidFile = join(dir, "child.pid");
    const command = "trap '' TERM; sleep 30 & echo $! > \"$1\"; wait";

    await expect(runSpecialistCommand(
      "/bin/bash",
      ["-c", command, "specialists-control", childPidFile],
      { env: process.env },
      { timeoutMs: 100, termGraceMs: 100, reapDeadlineMs: 2_000 },
    )).rejects.toThrow("timed out");

    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);
  });
});

function controlApp(repoPath: string): Hono {
  return new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, {
    readJob: () => job(),
    listRepos: () => [{ repoSlug: "repo-a", repoPath }] as never,
  }));
}

function controlRequest(): Request {
  return new Request("http://localhost/api/console/specialists/jobs/job-1/steer", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", "x-console-write-token": "secret" },
    body: JSON.stringify({ message: "continue" }),
  });
}

async function createRepoControlFixture(): Promise<string> {
  const repo = await makeTempDir("console-control-path-");
  await mkdir(join(repo, ".specialists", "jobs", "job-1"), { recursive: true });
  return repo;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function job(): SpecialistJob {
  return {
    jobId: "job-1",
    repoSlug: "repo-a",
    beadId: "bead-1",
    chainId: "chain-1",
    epicId: null,
    chainKind: "executor",
    status: "running",
    updatedAt: "2026-07-23T00:00:00.000Z",
    specialist: "executor",
    lastOutput: null,
    turns: 1,
    tools: 1,
    model: "model",
  };
}
