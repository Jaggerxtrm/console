import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import type { RawData } from "ws";
import WebSocketRuntime from "ws";
import type { LogEntry } from "../../../../packages/core/src/runtime/logs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SECRET = "phase5-secret-do-not-log";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "console-phase5-realtime-"));
  const dataDir = join(root, "data");
  const logDir = join(root, "logs");
  const projectsDir = join(root, "projects");
  const observabilityDir = join(root, "observability");
  await Promise.all([
    mkdir(projectsDir, { recursive: true }),
    mkdir(observabilityDir, { recursive: true }),
  ]);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const host = spawn("bun", ["src/server/index.ts"], {
    cwd: join(REPO_ROOT, "apps/console"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_PROJECTS_DIR: projectsDir,
      OBSERVABILITY_ROOTS: observabilityDir,
      XTRM_DATA_DIR: dataDir,
      LOG_DIR: logDir,
      SKIP_GITHUB_POLLER: "1",
      GITBOARD_ENABLE_PARITY: "0",
      XTRM_ENABLE_PARITY: "0",
      GITBOARD_STARTUP_MATERIALIZE: "0",
      XTRM_STARTUP_MATERIALIZE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = streamToString(host.stdout);
  const stderr = streamToString(host.stderr);

  try {
    await waitForHealth(baseUrl, host);

    const first = await connectWebSocket(port, baseUrl);
    const connected = await first.next();
    assert(connected.type === "connected", "missing realtime handshake");
    first.socket.send("{malformed");
    first.socket.send(JSON.stringify({
      action: "subscribe",
      channel: "system",
      version: "1",
      payload: SECRET,
    }));
    await postClientLog(baseUrl, "ui.phase5.live", { marker: "live", token: SECRET });
    const liveEnvelope = await first.next((message) => message.event === "system:log" && message.data?.event === "ui.phase5.live");
    assert(typeof liveEnvelope.seq === "number" && typeof liveEnvelope.boot_id === "string", "live envelope lacks replay cursor");
    first.socket.close();
    await waitForClose(first.socket);

    await postClientLog(baseUrl, "ui.phase5.replay", { marker: "buffered" });
    const second = await connectWebSocket(port, baseUrl);
    assert((await second.next()).type === "connected", "missing reconnect handshake");
    second.socket.send(JSON.stringify({
      action: "resume",
      channel: "system",
      since_seq: liveEnvelope.seq,
      boot_id: liveEnvelope.boot_id,
    }));
    await second.next((message) => message.event === "system:log" && message.data?.event === "ui.phase5.replay");

    const hostileStatus = await rawUpgradeStatus(port, "https://hostile.invalid");
    assert(hostileStatus === 403, `hostile origin returned ${hostileStatus}`);

    const logsResponse = await fetch(`${baseUrl}/api/internal/logs?component=ws&limit=100`);
    assert(logsResponse.ok, `internal logs returned ${logsResponse.status}`);
    const wsLogs = await logsResponse.json() as LogEntry[];
    assert(wsLogs.some((entry) => entry.event === "client.connected"), "connect telemetry missing");
    assert(wsLogs.some((entry) => entry.event === "client.disconnected"), "disconnect telemetry missing");

    const shutdownClose = waitForCloseCode(second.socket);
    host.kill("SIGTERM");
    const [, shutdownCloseCode] = await Promise.all([waitForExit(host), shutdownClose]);
    assert(host.exitCode === 0, `Console exited with ${host.exitCode}`);
    assert(shutdownCloseCode === 1001, `shutdown closed realtime client with ${shutdownCloseCode}`);
    const [out, err, diskLogs] = await Promise.all([stdout, stderr, readDiskLogs(logDir)]);
    const serialized = `${out}\n${err}\n${JSON.stringify(diskLogs)}`;
    assert(!serialized.includes(SECRET), "realtime logs leaked a raw payload or token");
    assert(!serialized.includes(root), "realtime logs leaked an absolute fixture path");
    assert(diskLogs.filter((entry) => entry.event === "client.disconnected").length >= 2, "shutdown disconnect telemetry missing");

    console.log(JSON.stringify({
      smoke: "phase5-realtime",
      result: "PASS",
      handshake: true,
      malformedInputSurvived: true,
      subscribe: true,
      reconnectReplay: true,
      shutdownCloseCode,
      hostileOriginStatus: hostileStatus,
      internalLogs: true,
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

interface RealtimeMessage {
  [key: string]: unknown;
  type?: string;
  event?: string;
  seq?: number;
  boot_id?: string;
  data?: { event?: string };
}

interface RealtimeClient {
  socket: WebSocket;
  next(predicate?: (message: RealtimeMessage) => boolean): Promise<RealtimeMessage>;
}

async function connectWebSocket(port: number, origin: string): Promise<RealtimeClient> {
  const socket = new WebSocketRuntime(`ws://127.0.0.1:${port}/api/console/ws`, { origin }) as WebSocket;
  const queue: RealtimeMessage[] = [];
  const waiters: Array<{
    predicate: (message: RealtimeMessage) => boolean;
    resolve: (message: RealtimeMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  socket.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString()) as RealtimeMessage;
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(message));
    if (waiterIndex < 0) {
      queue.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", () => { clearTimeout(timer); reject(new Error("WebSocket open failed")); });
  });
  return {
    socket,
    next(predicate = () => true) {
      const queuedIndex = queue.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("matching WebSocket message timed out"));
          }, 5_000),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === 3) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), 5_000);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForCloseCode(socket: WebSocket): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket shutdown close timed out")), 5_000);
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function postClientLog(baseUrl: string, event: string, data: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${baseUrl}/api/internal/logs/client`, {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ event, data }),
  });
  assert(response.ok, `client log returned ${response.status}`);
}

async function rawUpgradeStatus(port: number, origin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("hostile upgrade timed out")); }, 5_000);
    socket.once("connect", () => socket.write([
      "GET /api/console/ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Origin: ${origin}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: cGhhc2U1LXJlYWx0aW1l",
      "",
      "",
    ].join("\r\n")));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0);
      resolve(status);
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
    await sleep(100);
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
  const contents = await Promise.all(files.map((name) => readFile(join(logDir, name), "utf-8")));
  return contents.flatMap((content) => content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForExit(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return;
  await once(host, "exit");
}

async function streamToString(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
