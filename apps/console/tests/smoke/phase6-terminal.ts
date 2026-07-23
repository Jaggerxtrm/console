import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import type { RawData } from "ws";
import WebSocketRuntime from "ws";
import { createTerminalStreamEnvelope } from "../../../../packages/core/src/terminal/protocol.ts";
import type { LogEntry } from "../../../../packages/core/src/runtime/logs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ADMIN_TOKEN = "phase6-admin-token-do-not-log";
const TERMINAL_PAYLOAD = "phase6-terminal-payload-do-not-log";
const ENV_SECRET = "phase6-env-secret-do-not-inherit";
let currentStage = "startup";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "console-phase6-terminal-"));
  const dataDir = join(root, "data");
  const logDir = join(root, "logs");
  const projectsDir = join(root, "projects");
  const observabilityDir = join(root, "observability");
  const homeDir = join(root, "home");
  const distDir = join(root, "dist");
  await Promise.all([
    mkdir(projectsDir, { recursive: true }),
    mkdir(observabilityDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(distDir, { recursive: true }),
  ]);
  await writeFile(join(distDir, "index.html"), "<!doctype html><title>phase6</title>");

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const host = spawn("bun", ["src/server/index.ts"], {
    cwd: join(REPO_ROOT, "apps/console"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      HOME: homeDir,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_PROJECTS_DIR: projectsDir,
      OBSERVABILITY_ROOTS: observabilityDir,
      XTRM_DATA_DIR: dataDir,
      LOG_DIR: logDir,
      CONSOLE_DIST_DIR: distDir,
      SKIP_GITHUB_POLLER: "1",
      GITBOARD_ENABLE_PARITY: "0",
      XTRM_ENABLE_PARITY: "0",
      GITBOARD_STARTUP_MATERIALIZE: "0",
      XTRM_STARTUP_MATERIALIZE: "0",
      GITBOARD_SHELL_PROVIDER_ENABLED: "1",
      GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
      GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
      GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "1",
      GITBOARD_SHELL_PROVIDER_ADMIN_TOKEN: ADMIN_TOKEN,
      GITBOARD_SHELL_PROVIDER_ALLOWED_ORIGINS: baseUrl,
      GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: root,
      GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/sh",
      GITBOARD_SHELL_PROVIDER_ENV_SCRUB: `PHASE6_ENV_SECRET,GITHUB_TOKEN,SSH_AUTH_SOCK`,
      GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "1",
      GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "750",
      GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "5000",
      GITBOARD_SHELL_PROVIDER_MAX_INPUT_BPS: "256",
      GITBOARD_SHELL_PROVIDER_MAX_OUTPUT_BPS: "65536",
      GITBOARD_TERMINAL_NODE_BINARY: process.execPath,
      SHELL: "/bin/sh",
      PHASE6_ENV_SECRET: ENV_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = streamToString(host.stdout);
  const stderr = streamToString(host.stderr);

  try {
    await waitForHealth(baseUrl, host);

    currentStage = "upgrade-denials";
    const noTokenStatus = await rawUpgradeStatus(port, baseUrl);
    const badTokenStatus = await rawUpgradeStatus(port, baseUrl, "wrong-token");
    const hostileOriginStatus = await rawUpgradeStatus(port, "https://hostile.invalid", ADMIN_TOKEN);
    assert(noTokenStatus === 403, `missing token returned ${noTokenStatus}`);
    assert(badTokenStatus === 403, `bad token returned ${badTokenStatus}`);
    assert(hostileOriginStatus === 403, `hostile origin returned ${hostileOriginStatus}`);
    const deniedHelpers = await terminalHelperChildren(host.pid);
    assert(deniedHelpers.length === 0, `denied upgrades spawned PTY helpers: ${deniedHelpers.length}`);

    currentStage = "connect-positive-token";
    const client = await connectTerminal(port, baseUrl);
    currentStage = "malformed-input";
    client.socket.send("{malformed");
    await client.next((message) => message.kind === "error" && message.payload?.code === "invalid_json");

    currentStage = "forbidden-cwd";
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("open", "stream-bad-cwd", "bad-cwd", {
      providerKind: "pty",
      capabilities: ["interactive"],
      cwd: "/",
    })));
    const cwdError = await client.next((message) => message.sessionId === "bad-cwd" && message.kind === "error");
    assert(cwdError.payload?.code === "provider_error", "forbidden cwd did not return provider_error");
    assert(cwdError.payload?.message === "provider rejected request", "forbidden cwd exposed provider detail");

    currentStage = "pty-open";
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("open", "stream-live", "live", {
      providerKind: "pty",
      capabilities: ["interactive", "resizable"],
      cwd: root,
    })));
    await client.next((message) => message.sessionId === "live" && message.kind === "status");
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("resize", "stream-live", "live", { cols: 120, rows: 40 })));
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("input", "stream-live", "live", {
      data: `printf '${TERMINAL_PAYLOAD}\\n'; printf '%s\\n' "$PHASE6_ENV_SECRET"\n`,
      encoding: "utf8",
    })));
    currentStage = "pty-output";
    const terminalOutput = await collectOutput(client, "live", TERMINAL_PAYLOAD);
    assert(terminalOutput.includes(TERMINAL_PAYLOAD), "PTY did not return expected output");
    assert(!terminalOutput.includes(ENV_SECRET), "scrubbed environment secret reached PTY output");
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("input", "stream-live", "live", {
      data: "exit\n",
      encoding: "utf8",
    })));
    currentStage = "pty-exit";
    await client.next((message) => message.sessionId === "live" && message.kind === "exit");

    currentStage = "rate-open";
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("open", "stream-rate", "rate", {
      providerKind: "pty",
      capabilities: ["interactive"],
      cwd: root,
    })));
    await client.next((message) => message.sessionId === "rate" && message.kind === "status");
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("input", "stream-rate", "rate", {
      data: "x".repeat(257),
      encoding: "utf8",
    })));
    currentStage = "rate-error";
    const rateError = await client.next((message) => message.sessionId === "rate" && message.kind === "error");
    assert(rateError.payload?.code === "provider_error", "input rate limit did not reject");
    currentStage = "rate-exit";
    await client.next((message) => message.sessionId === "rate" && message.kind === "exit");

    currentStage = "idle-open";
    client.socket.send(JSON.stringify(createTerminalStreamEnvelope("open", "stream-idle", "idle", {
      providerKind: "pty",
      capabilities: ["interactive"],
      cwd: root,
    })));
    await client.next((message) => message.sessionId === "idle" && message.kind === "status");
    currentStage = "idle-exit";
    await client.next((message) => message.sessionId === "idle" && message.kind === "exit", 4_000);

    currentStage = "terminal-logs";
    const logsResponse = await fetch(`${baseUrl}/api/internal/logs?component=terminal&limit=200`);
    assert(logsResponse.ok, `terminal logs returned ${logsResponse.status}`);
    const terminalLogs = await logsResponse.json() as LogEntry[];
    assert(terminalLogs.some((entry) => entry.event === "upgrade.denied"), "upgrade denial telemetry missing");
    assert(terminalLogs.some((entry) => entry.event === "session.open"), "session open telemetry missing");
    assert(terminalLogs.some((entry) => entry.event === "session.close"), "session close telemetry missing");

    client.socket.close();
    await waitForClose(client.socket);
    host.kill("SIGTERM");
    await waitForExit(host);
    assert(host.exitCode === 0, `Console exited with ${host.exitCode}`);

    const [out, err, diskLogs] = await Promise.all([stdout, stderr, readDiskLogs(logDir)]);
    const serialized = `${out}\n${err}\n${JSON.stringify(diskLogs)}`;
    for (const forbidden of [ADMIN_TOKEN, TERMINAL_PAYLOAD, ENV_SECRET, root]) {
      assert(!serialized.includes(forbidden), `terminal logs leaked forbidden value: ${forbidden.slice(0, 12)}`);
    }

    console.log(JSON.stringify({
      smoke: "phase6-terminal",
      result: "PASS",
      missingTokenStatus: noTokenStatus,
      badTokenStatus,
      hostileOriginStatus,
      deniedUpgradePtyChildren: deniedHelpers.length,
      malformedInputSurvived: true,
      positiveTokenPtyLifecycle: true,
      forbiddenCwd: true,
      envScrub: true,
      inputRateLimit: true,
      idleCleanup: true,
      noLeak: true,
    }, null, 2));
  } finally {
    if (host.exitCode === null) {
      host.kill("SIGKILL");
      await waitForExit(host);
    }
    await rm(root, { recursive: true, force: true });
  }
}

interface TerminalMessage {
  kind?: string;
  sessionId?: string;
  payload?: { code?: string; message?: string; data?: string };
}

interface TerminalClient {
  socket: WebSocket;
  next(predicate?: (message: TerminalMessage) => boolean, timeoutMs?: number): Promise<TerminalMessage>;
}

async function connectTerminal(port: number, origin: string): Promise<TerminalClient> {
  const socket = new WebSocketRuntime(`ws://127.0.0.1:${port}/api/console/terminal/ws`, {
    origin,
    headers: { "x-gitboard-shell-token": ADMIN_TOKEN },
  }) as WebSocket;
  const queue: TerminalMessage[] = [];
  const waiters: Array<{
    predicate: (message: TerminalMessage) => boolean;
    resolve: (message: TerminalMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  socket.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString()) as TerminalMessage;
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) return void queue.push(message);
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal WebSocket open timed out")), 5_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  return {
    socket,
    next(predicate = () => true, timeoutMs = 5_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const pendingIndex = waiters.indexOf(waiter);
            if (pendingIndex >= 0) waiters.splice(pendingIndex, 1);
            const summary = queue.map((message) => ({
              kind: message.kind,
              sessionId: message.sessionId,
              code: message.payload?.code,
              message: message.payload?.message,
            }));
            reject(new Error(`matching terminal message timed out during ${currentStage}: ${JSON.stringify(summary)}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function collectOutput(client: TerminalClient, sessionId: string, marker: string): Promise<string> {
  let output = "";
  const deadline = Date.now() + 5_000;
  while (!output.includes(marker) && Date.now() < deadline) {
    const message = await client.next((candidate) => candidate.sessionId === sessionId && candidate.kind === "output");
    output += message.payload?.data ?? "";
  }
  return output;
}

async function rawUpgradeStatus(port: number, origin: string, token?: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("terminal upgrade timed out")); }, 5_000);
    socket.once("connect", () => socket.write([
      "GET /api/console/terminal/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Origin: ${origin}`,
      ...(token ? [`X-Gitboard-Shell-Token: ${token}`] : []),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: cGhhc2U2LXRlcm1pbmFs",
      "",
      "",
    ].join("\r\n")));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0));
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function waitForHealth(baseUrl: string, host: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error(`Console exited before health (${host.exitCode})`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Console health timed out");
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  assert(port > 0, "failed to reserve a port");
  return port;
}

async function readDiskLogs(logDir: string): Promise<LogEntry[]> {
  const files = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl"));
  const contents = await Promise.all(files.map((name) => readFile(join(logDir, name), "utf8")));
  return contents.flatMap((content) => content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry));
}

async function terminalHelperChildren(parentPid: number | undefined): Promise<string[]> {
  assert(parentPid, "Console host pid unavailable");
  const childList = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").catch(() => "");
  const commandLines = await Promise.all(childList.trim().split(/\s+/).filter(Boolean).map(async (pid) => {
    return await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  }));
  return commandLines.filter((commandLine) => commandLine.includes("node-pty-helper.cjs"));
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === 3) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal WebSocket close timed out")), 5_000);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForExit(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  await once(host, "exit");
}

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
