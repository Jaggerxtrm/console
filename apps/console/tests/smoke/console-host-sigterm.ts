import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

interface LogEntry {
  event?: string;
  [key: string]: unknown;
}

interface SmokeResult {
  smoke: "console-host-sigterm";
  result: "PASS" | "FAIL";
  exitCode: number | null;
  signal: string | null;
  healthStatus: number;
  consoleStatus: number;
  events: string[];
  homePathRedacted: boolean;
  detail?: string;
}

const REPO_ROOT = join(import.meta.dir, "../../../..");
const ENTRYPOINT = join(REPO_ROOT, "apps/console/src/server/index.ts");
const INDEX_HTML = "<!doctype html><html><body>console-host-sigterm</body></html>";

function parseLine(line: string): LogEntry | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed as LogEntry : null;
  } catch {
    return null;
  }
}

type SmokeChild = ChildProcessByStdio<null, Readable, Readable>;

function createEventWaiter(event: string, timeoutMs = 8_000): {
  promise: Promise<LogEntry>;
  accept(entry: LogEntry): void;
} {
  let resolveWaiter!: (entry: LogEntry) => void;
  let rejectWaiter!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<LogEntry>((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectWaiter(new Error(`timed out waiting for ${event}`));
  }, timeoutMs);
  return {
    promise,
    accept: (entry) => {
      if (settled || entry.event !== event) return;
      settled = true;
      clearTimeout(timer);
      resolveWaiter(entry);
    },
  };
}

async function main(): Promise<SmokeResult> {
  const fixtureRoot = mkdtempSync(join(homedir(), ".console-host-sigterm-"));
  const distDir = join(fixtureRoot, "dist");
  const dataDir = mkdtempSync(join("/tmp", "console-host-sigterm-data-"));
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);

  const lines: string[] = [];
  let stderr = "";
  let child: SmokeChild | null = null;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let healthStatus = 0;
  let consoleStatus = 0;

  try {
    const spawned = spawn("bun", [ENTRYPOINT], {
      windowsHide: true,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        CONSOLE_DIST_DIR: distDir,
        XTRM_DATA_DIR: dataDir,
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned as SmokeChild;
    spawned.on("error", (error) => { stderr += `spawn-error: ${String(error)}`; });
    let stdoutBuffer = "";
    const listeningWaiter = createEventWaiter("host.listening");
    spawned.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      const parts = stdoutBuffer.split("\n");
      stdoutBuffer = parts.pop() ?? "";
      for (const line of parts.filter(Boolean)) {
        lines.push(line);
        const entry = parseLine(line);
        if (entry) listeningWaiter.accept(entry);
      }
    });
    spawned.stderr.on("data", (chunk) => { stderr += String(chunk); });

    const listening = await listeningWaiter.promise.catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr}; entrypoint=${ENTRYPOINT}`);
    });
    const url = String(listening.url);
    const health = await fetch(`${url}/health`);
    const consoleResponse = await fetch(`${url}/console`);
    healthStatus = health.status;
    consoleStatus = consoleResponse.status;

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      spawned.once("exit", (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    spawned.kill("SIGTERM");
    const result = await exited;
    exitCode = result.code;
    signal = result.signal;

    const logs = lines.map(parseLine).filter((entry): entry is LogEntry => entry !== null);
    const events = logs.map((entry) => String(entry.event)).filter(Boolean);
    const requiredEvents = ["host.starting", "host.listening", "host.shutting_down", "host.shutdown"];
    const homePathRedacted = !lines.join("\n").includes(homedir());
    const missingEvents = requiredEvents.filter((event) => !events.includes(event));
    if (healthStatus !== 200) throw new Error(`/health returned ${healthStatus}`);
    if (consoleStatus !== 200) throw new Error(`/console returned ${consoleStatus}`);
    if (exitCode !== 0 || signal !== null) throw new Error(`expected clean exit, got code=${exitCode} signal=${signal}`);
    if (missingEvents.length > 0) throw new Error(`missing events: ${missingEvents.join(", ")}`);
    if (!homePathRedacted) throw new Error(`raw home path leaked in logs: ${stderr}`);

    return {
      smoke: "console-host-sigterm",
      result: "PASS",
      exitCode,
      signal,
      healthStatus,
      consoleStatus,
      events,
      homePathRedacted,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  const result: SmokeResult = {
    smoke: "console-host-sigterm",
    result: "FAIL",
    exitCode: null,
    signal: null,
    healthStatus: 0,
    consoleStatus: 0,
    events: [],
    homePathRedacted: false,
    detail: error instanceof Error ? error.message : String(error),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
