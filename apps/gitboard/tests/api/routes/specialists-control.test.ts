import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createSpecialistsControlRouter } from "../../../src/api/routes/specialists-control.ts";
import type { UpdatedJob } from "../../../src/api/routes/specialists-control.ts";

const originalConsoleToken = process.env.CONSOLE_WRITE_ADMIN_TOKEN;
const originalLegacyToken = process.env.GITBOARD_SOURCES_ADMIN_TOKEN;

beforeEach(() => {
  process.env.CONSOLE_WRITE_ADMIN_TOKEN = "console-secret";
  delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
});

afterEach(() => {
  if (originalConsoleToken === undefined) delete process.env.CONSOLE_WRITE_ADMIN_TOKEN;
  else process.env.CONSOLE_WRITE_ADMIN_TOKEN = originalConsoleToken;
  if (originalLegacyToken === undefined) delete process.env.GITBOARD_SOURCES_ADMIN_TOKEN;
  else process.env.GITBOARD_SOURCES_ADMIN_TOKEN = originalLegacyToken;
});

describe("createSpecialistsControlRouter", () => {
  it("runs stop with expected args and returns updated job", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const writeControlMessage = vi.fn().mockResolvedValue(undefined);
    const readJob = vi.fn<(jobId: string) => UpdatedJob | null>()
      .mockReturnValueOnce(job("running"))
      .mockReturnValueOnce(job("cancelled", "job-1", "2026-07-06T00:00:01.000Z"));
    const app = new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, { runCommand, writeControlMessage, readJob, env: { GITBOARD_SPECIALISTS_BIN: "sp" } }));

    const res = await app.fetch(request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", body: "{}" }));

    expect(res.status).toBe(200);
    expect(runCommand).toHaveBeenCalledWith("sp", ["stop", "job-1"], expect.objectContaining({ env: expect.objectContaining({ NO_COLOR: "1", FORCE_COLOR: "0" }) }));
    expect(writeControlMessage).not.toHaveBeenCalled();
    expect((await res.json()) as { job: UpdatedJob }).toEqual({ job: expect.objectContaining({ status: "cancelled", jobId: "job-1" }) });
  });

  it("sends steer and resume text through the control pipe, not argv", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const writeControlMessage = vi.fn().mockResolvedValue(undefined);
    const readJob = vi.fn<(jobId: string) => UpdatedJob | null>((jobId) => {
      if (jobId === "job-keep") return job("waiting", "job-keep", "2026-07-06T00:00:01.000Z");
      return job("running", "job-2", "2026-07-06T00:00:01.000Z");
    });
    const app = new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, { runCommand, writeControlMessage, readJob, env: { GITBOARD_SPECIALISTS_BIN: "sp" } }));

    const steerRes = await app.fetch(request("http://localhost/api/console/specialists/jobs/job-2/steer", { method: "POST", body: JSON.stringify({ message: "Focus failing test" }) }));
    const resumeRes = await app.fetch(request("http://localhost/api/console/specialists/jobs/job-keep/resume", { method: "POST", body: JSON.stringify({ task: "Continue from checkpoint" }) }));

    expect(steerRes.status).toBe(200);
    expect(resumeRes.status).toBe(200);
    expect(runCommand).not.toHaveBeenCalled();
    expect(writeControlMessage).toHaveBeenNthCalledWith(1, "steer", "job-2", "Focus failing test", undefined);
    expect(writeControlMessage).toHaveBeenNthCalledWith(2, "resume", "job-keep", "Continue from checkpoint", undefined);
  });

  it("rejects forbidden requests and force stop", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const readJob = vi.fn().mockReturnValue(job("running"));
    const app = new Hono().route("/api/console/specialists", createSpecialistsControlRouter(null, { runCommand, readJob }));

    const forbiddenRes = await app.fetch(new Request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", headers: { origin: "https://example.com", host: "localhost" }, body: "{}" }));
    const forceRes = await app.fetch(request("http://localhost/api/console/specialists/jobs/job-1/stop", { method: "POST", body: JSON.stringify({ force: true }) }));

    expect(forbiddenRes.status).toBe(403);
    expect(forceRes.status).toBe(400);
    expect(await forceRes.json()).toEqual({ error: "force stop unsupported", code: "force_stop_unsupported" });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

function request(url: string, init: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      host: "localhost",
      "x-console-write-token": "console-secret",
      ...(init.headers ?? {}),
    },
  });
}

function job(status: string, jobId = "job-1", updatedAt = "2026-07-06T00:00:00.000Z"): UpdatedJob {
  return {
    jobId,
    repoSlug: "repo-a",
    beadId: "forge-1",
    chainId: "chain-1",
    epicId: null,
    chainKind: "executor",
    status,
    updatedAt,
    specialist: "executor",
    lastOutput: null,
    turns: 1,
    tools: 1,
    model: "gpt-5",
  };
}
