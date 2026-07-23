import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeLogEntry, type LogEntry } from "../../../../../packages/core/src/runtime/index.ts";
import { listRepos, type RepoEntry, type SpecialistJob } from "../../../../../packages/core/src/observability/index.ts";
import { readSpecialistInFlightJobs, readSpecialistRecentJobs } from "../../../../../packages/core/src/state/index.ts";
import { isAllowedConsoleWriteRequest } from "../../../../../packages/core/src/runtime/console-write-policy.ts";

type ControlAction = "stop" | "steer" | "resume";

type CommandRunner = (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) => Promise<void>;
type ControlMessageWriter = (action: Extract<ControlAction, "steer" | "resume">, jobId: string, text: string, cwd?: string) => Promise<void>;

type RouteDeps = {
  runCommand?: CommandRunner;
  writeControlMessage?: ControlMessageWriter;
  readJob?: (jobId: string) => SpecialistJob | null;
  env?: NodeJS.ProcessEnv;
  listRepos?: () => readonly RepoEntry[];
  emit?: (entry: LogEntry) => void;
};

type StopBody = { force?: boolean };

type SteerBody = { message?: string };

type ResumeBody = { task?: string };

const JOB_ID_RE = /^[A-Za-z0-9._:-]{3,128}$/;
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_TERM_GRACE_MS = 2_000;
const COMMAND_REAP_DEADLINE_MS = 4_000;

export function createSpecialistsControlRouter(xtrmDb: Database | null, deps: RouteDeps = {}): Hono {
  const router = new Hono();
  const readJob = deps.readJob ?? createJobReader(xtrmDb);
  const runCommand = deps.runCommand ?? runSpecialistCommand;
  const writeControlMessage = deps.writeControlMessage ?? writeSpecialistControlMessage;
  const env = deps.env ?? process.env;
  const repoLister = deps.listRepos ?? listRepos;
  const log = deps.emit ?? (() => {});

  router.post("/jobs/:job_id/stop", async (c) => {
    if (!isControlRequestAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const jobId = c.req.param("job_id");
    if (!JOB_ID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
    const body = (await c.req.json<StopBody>().catch(() => ({}))) as StopBody;
    if (body.force === true) {
      return c.json({ error: "force stop unsupported", code: "force_stop_unsupported" }, 400);
    }
    const currentJob = readJob(jobId);
    if (!currentJob) return c.json({ error: "job not found" }, 404);
    await handleAction({ action: "stop", job: currentJob, env, runCommand, writeControlMessage, repoLister, log });
    return c.json({ job: await readUpdatedJob(readJob, jobId, currentJob) });
  });

  router.post("/jobs/:job_id/steer", async (c) => {
    if (!isControlRequestAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const jobId = c.req.param("job_id");
    if (!JOB_ID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
    const body = (await c.req.json<SteerBody>().catch(() => ({}))) as SteerBody;
    const message = body.message?.trim() ?? "";
    if (!message) return c.json({ error: "missing message" }, 400);
    const currentJob = readJob(jobId);
    if (!currentJob) return c.json({ error: "job not found" }, 404);
    await handleAction({ action: "steer", job: currentJob, env, runCommand, writeControlMessage, text: message, repoLister, log });
    return c.json({ job: await readUpdatedJob(readJob, jobId, currentJob) });
  });

  router.post("/jobs/:job_id/resume", async (c) => {
    if (!isControlRequestAllowed(c.req)) return c.json({ error: "forbidden" }, 403);
    const jobId = c.req.param("job_id");
    if (!JOB_ID_RE.test(jobId)) return c.json({ error: "invalid job id" }, 400);
    const body = (await c.req.json<ResumeBody>().catch(() => ({}))) as ResumeBody;
    const task = body.task?.trim() ?? "";
    if (!task) return c.json({ error: "missing task" }, 400);
    const currentJob = readJob(jobId);
    if (!currentJob) return c.json({ error: "job not found" }, 404);
    if (!isKeepAliveJob(currentJob)) return c.json({ error: "resume unavailable", code: "resume_unavailable" }, 409);
    await handleAction({ action: "resume", job: currentJob, env, runCommand, writeControlMessage, text: task, repoLister, log });
    return c.json({ job: await readUpdatedJob(readJob, jobId, currentJob) });
  });

  return router;
}

function isControlRequestAllowed(request: { url: string; header: (name: string) => string | undefined | null }): boolean {
  return isAllowedConsoleWriteRequest(
    request.url,
    request.header("host") ?? "",
    request.header("origin") ?? null,
    request.header("x-console-write-token") ?? request.header("x-gitboard-sources-admin-token") ?? null,
    process.env,
    request.header("x-xtrm-peer-address"),
  );
}

function createJobReader(xtrmDb: Database | null): (jobId: string) => SpecialistJob | null {
  return (jobId) => {
    const jobs = [
      ...readSpecialistInFlightJobs(xtrmDb),
      ...readSpecialistRecentJobs(xtrmDb, 500),
    ];
    const row = jobs.find((job) => job.jobId === jobId || job.beadId === jobId);
    return row ? { ...row } : null;
  };
}

async function handleAction(args: { action: ControlAction; job: SpecialistJob; env: NodeJS.ProcessEnv; runCommand: CommandRunner; writeControlMessage: ControlMessageWriter; text?: string; repoLister: () => readonly RepoEntry[]; log: (entry: LogEntry) => void }): Promise<void> {
  const startedAt = performance.now();
  const command = args.env.GITBOARD_SPECIALISTS_BIN || "sp";
  const repo = args.repoLister().find((entry) => entry.repoSlug === args.job.repoSlug);
  const effectiveJobId = args.job.jobId ?? args.job.beadId;
  if (!JOB_ID_RE.test(effectiveJobId)) throw new Error("invalid persisted job id");
  const commandArgs = buildCommandArgs(args.action, effectiveJobId);
  const baseMetadata = {
    action: args.action,
    jobId: args.job.jobId,
    beadId: args.job.beadId,
    chainId: args.job.chainId,
    repoSlug: args.job.repoSlug,
    specialist: args.job.specialist,
    status: args.job.status,
  };

  try {
    if (args.action === "stop") {
      await args.runCommand(command, commandArgs, { cwd: repo?.repoPath, env: buildCommandEnv(args.env) });
    } else {
      await args.writeControlMessage(args.action, effectiveJobId, args.text ?? "", repo?.repoPath);
    }
    args.log(makeLogEntry("api", "specialists.control", "info", undefined, {
      ...baseMetadata,
      outcome: "success",
      duration_ms: Math.round(performance.now() - startedAt),
    }));
  } catch {
    args.log(makeLogEntry("api", "specialists.control", "warn", undefined, {
      ...baseMetadata,
      outcome: "error",
      duration_ms: Math.round(performance.now() - startedAt),
      error: `sp ${args.action} failed`,
    }));
    throw new Error(`sp ${args.action} failed`);
  }
}

async function readUpdatedJob(readJob: (jobId: string) => SpecialistJob | null, jobId: string, currentJob: SpecialistJob): Promise<SpecialistJob> {
  let latest = readJob(jobId);
  for (let attempt = 0; attempt < 5 && latest && !hasChanged(latest, currentJob); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = readJob(jobId) ?? latest;
  }
  return latest ?? currentJob;
}

function hasChanged(next: SpecialistJob, previous: SpecialistJob): boolean {
  return next.status !== previous.status || next.updatedAt !== previous.updatedAt;
}

function buildCommandArgs(action: ControlAction, jobId: string): string[] {
  return [action, jobId];
}

async function writeSpecialistControlMessage(action: Extract<ControlAction, "steer" | "resume">, jobId: string, text: string, cwd?: string): Promise<void> {
  if (!JOB_ID_RE.test(jobId)) throw new Error("invalid persisted job id");
  const jobsDir = realpathSync(resolveJobsDir(cwd ?? process.cwd()));
  const jobDir = realpathSync(containedPath(jobsDir, join(jobsDir, jobId)));
  containedPath(jobsDir, jobDir);
  const status = readSpecialistStatus(jobId, jobsDir, jobDir);
  if (!status?.fifo_path) throw new Error("specialists control pipe unavailable");
  const candidate = containedPath(jobDir, resolve(jobDir, status.fifo_path));
  const parent = realpathSync(dirname(candidate));
  containedPath(jobDir, parent);
  const fifoPath = join(parent, basename(candidate));
  const payload = action === "resume" ? { type: "resume", task: text } : { type: "steer", message: text };
  const descriptor = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFIFO()) throw new Error("specialists control pipe is not a fifo");
    writeSync(descriptor, `${JSON.stringify(payload)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function readSpecialistStatus(jobId: string, jobsDir: string, jobDir: string): { fifo_path?: string } | null {
  const statusCandidate = containedPath(jobsDir, join(jobsDir, jobId, "status.json"));
  if (!existsSync(statusCandidate)) return null;
  const statusPath = realpathSync(statusCandidate);
  containedPath(jobDir, statusPath);
  try {
    return JSON.parse(readFileSync(statusPath, "utf-8")) as { fifo_path?: string };
  } catch {
    return null;
  }
}

function containedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new Error("specialists control path escapes job directory");
  }
  return resolvedCandidate;
}

function resolveJobsDir(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const gitCommonDir = result.status === 0 ? result.stdout.trim() : "";
  const root = gitCommonDir ? dirname(resolve(cwd, gitCommonDir)) : cwd;
  return join(root, ".specialists", "jobs");
}

function buildCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

export async function runSpecialistCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
  timing: { timeoutMs?: number; termGraceMs?: number; reapDeadlineMs?: number } = {},
): Promise<void> {
  const timeoutMs = timing.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const termGraceMs = timing.termGraceMs ?? COMMAND_TERM_GRACE_MS;
  const reapDeadlineMs = timing.reapDeadlineMs ?? COMMAND_REAP_DEADLINE_MS;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let reapPoll: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (reapDeadline) clearTimeout(reapDeadline);
      if (reapPoll) clearInterval(reapPoll);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
      const completeWhenReaped = () => {
        if (childClosed && !isProcessGroupAlive(child.pid)) finish(new Error("specialists control timed out"));
      };
      reapPoll = setInterval(completeWhenReaped, 20);
      killTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        completeWhenReaped();
      }, termGraceMs);
      reapDeadline = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
        finish(new Error("specialists control timed out"));
      }, termGraceMs + reapDeadlineMs);
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      childClosed = true;
      if (timedOut) {
        if (!isProcessGroupAlive(child.pid)) finish(new Error("specialists control timed out"));
        return;
      }
      if (code === 0) return finish();
      finish(new Error(`specialists control exited ${code}`));
    });
  });
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals, fallback: () => void): void {
  if (!pid) return fallback();
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") fallback();
  }
}

function isProcessGroupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isKeepAliveJob(job: SpecialistJob): boolean {
  // The specialists read model exposes keep-alive sessions as waiting jobs; no separate keepAlive flag exists today.
  return job.status === "waiting";
}

export type { SpecialistJob as UpdatedJob };
export { isKeepAliveJob };
