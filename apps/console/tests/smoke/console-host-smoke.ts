import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleHost, type ConsoleHostHooks } from "../../src/server/host.ts";
import { createHostLogger } from "../../src/server/log.ts";

interface ProbeResult {
  path: string;
  status: number;
  contentType: string | null;
  bytes: number;
  ok: boolean;
}

interface ScenarioResult {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const INDEX_HTML = "<!doctype html><html><body>console-host-smoke</body></html>";

function makeFixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "console-host-smoke-dist-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  writeFileSync(join(dir, "assets", "app.js"), "export const answer = 42;");
  return dir;
}

function silentLogger() {
  return createHostLogger({ sink: () => {} });
}

async function probe(baseUrl: string, path: string, expectHtml: boolean): Promise<ProbeResult> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();
  const contentType = response.headers.get("content-type");
  const ok = response.status === 200 && (expectHtml ? body.includes("console-host-smoke") : body.length > 0);
  return { path, status: response.status, contentType, bytes: body.length, ok };
}

async function canConnect(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/health`);
    return true;
  } catch {
    return false;
  }
}

async function happyPath(distDir: string): Promise<ScenarioResult> {
  const hookCalls: string[] = [];
  const hooks: ConsoleHostHooks = {
    mountRoutes: () => { hookCalls.push("mountRoutes"); return []; },
    attachWebSocket: () => { hookCalls.push("attachWebSocket"); },
    attachTerminal: () => { hookCalls.push("attachTerminal"); },
    startBackground: () => { hookCalls.push("startBackground"); },
    stopBackground: () => { hookCalls.push("stopBackground"); },
  };
  const host = createConsoleHost({ port: 0, hostname: "127.0.0.1", consoleDistDir: distDir, logger: silentLogger(), hooks });
  const running = await host.start();

  const probes = [
    await probe(running.url, "/health", false),
    await probe(running.url, "/console", true),
    await probe(running.url, "/console/specialists/deep", true),
    await probe(running.url, "/console/assets/app.js", false),
  ];
  const health = await fetch(`${running.url}/health`).then((r) => r.json());

  await running.stop();
  await running.stop(); // idempotent: second call is a no-op
  const released = !(await canConnect(running.url));

  const expectedHooks = ["mountRoutes", "startBackground", "attachWebSocket", "attachTerminal", "stopBackground"];
  const ok =
    probes.every((p) => p.ok) &&
    health.status === "ok" &&
    expectedHooks.every((name) => hookCalls.includes(name)) &&
    released;

  return { name: "happy-path", ok, detail: { probes, health, hookCalls, released, descriptor: host.descriptor.owner } };
}

async function stopBackgroundThrows(distDir: string): Promise<ScenarioResult> {
  const host = createConsoleHost({
    port: 0,
    hostname: "127.0.0.1",
    consoleDistDir: distDir,
    logger: silentLogger(),
    hooks: { stopBackground: () => { throw new Error("stopBackground boom"); } },
  });
  const running = await host.start();
  const url = running.url;

  let rejected = false;
  try {
    await running.stop();
  } catch {
    rejected = true;
  }
  const released = !(await canConnect(url));
  return { name: "stop-releases-listener-when-stopBackground-throws", ok: rejected && released, detail: { rejected, released } };
}

async function attachThrows(distDir: string): Promise<ScenarioResult> {
  let stopBackgroundCalled = false;
  const host = createConsoleHost({
    port: 0,
    hostname: "127.0.0.1",
    consoleDistDir: distDir,
    logger: silentLogger(),
    hooks: {
      attachWebSocket: () => { throw new Error("attach boom"); },
      stopBackground: () => { stopBackgroundCalled = true; },
    },
  });

  let rejected = false;
  let leakedUrl: string | null = null;
  try {
    const running = await host.start();
    leakedUrl = running.url;
  } catch {
    rejected = true;
  }
  const leaked = leakedUrl ? await canConnect(leakedUrl) : false;
  return { name: "attach-failure-leaks-no-listener", ok: rejected && !leaked && stopBackgroundCalled, detail: { rejected, leaked, stopBackgroundCalled } };
}

async function startBackgroundThrows(distDir: string): Promise<ScenarioResult> {
  const host = createConsoleHost({
    port: 0,
    hostname: "127.0.0.1",
    consoleDistDir: distDir,
    logger: silentLogger(),
    hooks: { startBackground: () => { throw new Error("start boom"); } },
  });

  let rejected = false;
  try {
    await host.start();
  } catch {
    rejected = true;
  }
  return { name: "startBackground-failure-rejects", ok: rejected, detail: { rejected } };
}

async function main(): Promise<void> {
  const distDir = process.env.CONSOLE_DIST_DIR?.trim() || makeFixtureDist();
  const scenarios: ScenarioResult[] = [];
  try {
    scenarios.push(await happyPath(distDir));
    scenarios.push(await stopBackgroundThrows(distDir));
    scenarios.push(await attachThrows(distDir));
    scenarios.push(await startBackgroundThrows(distDir));
  } finally {
    if (distDir.includes("console-host-smoke-dist-")) rmSync(distDir, { recursive: true, force: true });
  }

  const failed = scenarios.some((s) => !s.ok);
  console.log(JSON.stringify({ smoke: "console-host", result: failed ? "FAIL" : "PASS", scenarios }, null, 2));
  process.exit(failed ? 1 : 0);
}

await main();
