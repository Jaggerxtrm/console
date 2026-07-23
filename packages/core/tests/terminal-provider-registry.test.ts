import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTerminalProviderRegistry,
  type TerminalProviderSession,
} from "../src/terminal/provider-registry.ts";

const tempDirs: string[] = [];
const sessions: TerminalProviderSession[] = [];

function makeFixture(): { root: string; helperPath: string } {
  const root = mkdtempSync(join(tmpdir(), "console-terminal-provider-"));
  tempDirs.push(root);
  mkdirSync(join(root, "allowed"));
  const helperPath = join(root, "fake-helper.cjs");
  writeFileSync(helperPath, `#!/usr/bin/env node
const readline = require("node:readline");
const config = JSON.parse(Buffer.from(process.env.GITBOARD_TERMINAL_PTY_CONFIG, "base64url").toString("utf8"));
const send = (data) => process.stdout.write(JSON.stringify({ type: "output", data: Buffer.from(data).toString("base64") }) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "dispose") setTimeout(() => process.exit(0), 75);
  if (message.type === "resize") send("resize:" + message.cols + "x" + message.rows);
  if (message.type !== "input") return;
  const input = Buffer.from(message.data, "base64").toString("utf8");
  if (input === "__env__") send(JSON.stringify({ cwd: config.cwd, env: config.env }));
  else if (input === "__burst__") send("123456789");
  else if (input === "__malformed__") process.stdout.write("helper-secret-path\\n");
  else send(input);
});
`);
  chmodSync(helperPath, 0o755);
  return { root, helperPath };
}

function makeRegistry(
  overrides: NodeJS.ProcessEnv = {},
  fixture = makeFixture(),
) {
  const env = {
    NODE_ENV: "development",
    HOST: "localhost",
    GITBOARD_SHELL_PROVIDER_ENABLED: "1",
    GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
    GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
    GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
    GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: fixture.root,
    GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/sh",
    GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "2",
    GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "5000",
    GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "10000",
    GITBOARD_SHELL_PROVIDER_MAX_INPUT_BPS: "1024",
    GITBOARD_SHELL_PROVIDER_MAX_OUTPUT_BPS: "1024",
    GITBOARD_TERMINAL_NODE_BINARY: process.execPath,
    SHELL: "/bin/sh",
    PATH: process.env.PATH,
    HOME: "/home/terminal-test",
    USER: "terminal-test",
    SECRET_TOKEN: "must-not-cross-boundary",
    ...overrides,
  } as NodeJS.ProcessEnv;
  return {
    registry: createTerminalProviderRegistry(env, { repoRoot: fixture.root, ptyHelperPath: fixture.helperPath }),
    fixture,
  };
}

async function openSession(registry: ReturnType<typeof createTerminalProviderRegistry>, cwd = ".") {
  const provider = registry.get("pty", { isVerifiedAdmin: true });
  expect(provider?.enabled).toBe(true);
  const session = await provider!.openSession({ sessionId: crypto.randomUUID(), capabilities: ["interactive"], cwd });
  sessions.push(session);
  return session;
}

function nextOutput(session: TerminalProviderSession): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal output timed out")), 2_000);
    session.onOutput((data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function nextExit(session: TerminalProviderSession): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal exit timed out")), 2_000);
    session.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.dispose("test_cleanup")));
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("terminal provider registry", () => {
  it("uses the Console helper and keeps the specialist feed admin-only", () => {
    const { registry } = makeRegistry();

    expect(registry.get("pty", { isVerifiedAdmin: true })?.reason).toBe("node-pty helper");
    expect(registry.get("specialist-feed")?.enabled).toBe(false);
    expect(registry.get("specialist-feed", { isVerifiedAdmin: true })?.enabled).toBe(true);
  });

  it("streams the specialist feed read-only and validates its job id", async () => {
    const fixture = makeFixture();
    const feed = join(fixture.root, "fake-specialists.sh");
    writeFileSync(feed, "#!/bin/sh\nprintf 'feed:%s\\n' \"$*\"\n");
    chmodSync(feed, 0o755);
    const { registry } = makeRegistry({ GITBOARD_SPECIALISTS_BIN: feed }, fixture);
    const provider = registry.get("specialist-feed", { isVerifiedAdmin: true });

    await expect(provider!.openSession({ sessionId: "bad", capabilities: ["readonly"], jobId: "bad id" })).rejects.toThrow(/invalid specialist job id/);
    const session = await provider!.openSession({ sessionId: "feed", capabilities: ["readonly"], jobId: "abc123" });
    sessions.push(session);
    const output = nextOutput(session);
    await session.input("ignored");
    await session.resize(120, 40);

    expect(await output).toContain("feed:feed abc123 --follow");
  });

  it("waits for a readonly specialist feed process to exit on dispose", async () => {
    const fixture = makeFixture();
    const feed = join(fixture.root, "slow-specialists.sh");
    writeFileSync(feed, "#!/bin/sh\nexec sleep 10\n");
    chmodSync(feed, 0o755);
    const { registry } = makeRegistry({ GITBOARD_SPECIALISTS_BIN: feed }, fixture);
    const session = await registry.get("specialist-feed", { isVerifiedAdmin: true })!.openSession({
      sessionId: "feed",
      capabilities: ["readonly"],
      jobId: "abc123",
    });
    sessions.push(session);
    let exited = false;
    session.onExit(() => { exited = true; });

    await session.dispose("test_shutdown");
    expect(exited).toBe(true);
  });

  it("rejects a runtime shell outside the configured allowlist", async () => {
    const { registry } = makeRegistry({
      SHELL: "/bin/bash",
      GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/sh",
    });
    const provider = registry.get("pty", { isVerifiedAdmin: true });

    await expect(provider!.openSession({ sessionId: "shell", capabilities: [], cwd: "." })).rejects.toThrow(/shell outside allowlist/);
  });

  it("rejects missing, outside, and symlink-escaped cwd before spawning", async () => {
    const { registry, fixture } = makeRegistry({ GITBOARD_TERMINAL_NODE_BINARY: "/definitely/missing/node" });
    const outside = mkdtempSync(join(tmpdir(), "console-terminal-outside-"));
    tempDirs.push(outside);
    symlinkSync(outside, join(fixture.root, "allowed", "escape"));
    const provider = registry.get("pty", { isVerifiedAdmin: true });

    await expect(provider!.openSession({ sessionId: "outside", capabilities: [], cwd: outside })).rejects.toThrow(/cwd outside allowlist/);
    await expect(provider!.openSession({ sessionId: "missing", capabilities: [], cwd: "missing" })).rejects.toThrow();
    await expect(provider!.openSession({ sessionId: "escape", capabilities: [], cwd: "allowed/escape" })).rejects.toThrow(/cwd outside allowlist/);
  });

  it("scrubs configured environment values and clamps resize dimensions", async () => {
    const { registry, fixture } = makeRegistry({
      GITBOARD_SHELL_PROVIDER_ENV_SCRUB: "SECRET_TOKEN,HOME,PATH",
    });
    const session = await openSession(registry, "allowed");
    let output = nextOutput(session);
    await session.input("__env__");
    const config = JSON.parse(await output) as { cwd: string; env: Record<string, string> };

    expect(config.cwd).toBe(join(fixture.root, "allowed"));
    expect(config.env.SECRET_TOKEN).toBeUndefined();
    expect(config.env.HOME).toBeUndefined();
    expect(config.env.PATH).toBeUndefined();

    output = nextOutput(session);
    await session.resize(1000, -20);
    expect(await output).toBe("resize:500x1");
  });

  it("enforces the active session cap and releases capacity on dispose", async () => {
    const { registry } = makeRegistry({ GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "1" });
    const first = await openSession(registry);

    await expect(openSession(registry)).rejects.toThrow(/session cap/);
    const disposing = first.dispose("test_release");
    await expect(openSession(registry)).rejects.toThrow(/session cap/);
    await disposing;
    await expect(openSession(registry)).resolves.toBeDefined();
  });

  it("terminates a session that exceeds its input budget", async () => {
    const { registry } = makeRegistry({ GITBOARD_SHELL_PROVIDER_MAX_INPUT_BPS: "8" });
    const session = await openSession(registry);

    await expect(session.input("12345678")).resolves.toBeUndefined();
    await expect(session.input("9")).rejects.toThrow(/input rate limit exceeded/);
    await expect(openSession(registry)).resolves.toBeDefined();
  });

  it("terminates a session that exceeds its output budget", async () => {
    const { registry } = makeRegistry({ GITBOARD_SHELL_PROVIDER_MAX_OUTPUT_BPS: "8" });
    const session = await openSession(registry);
    const exited = nextExit(session);

    await session.input("__burst__");
    await exited;
    await expect(openSession(registry)).resolves.toBeDefined();
  });

  it("disposes idle sessions and releases their capacity", async () => {
    const { registry } = makeRegistry({
      GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "1",
      GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "30",
      GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "2000",
    });
    const session = await openSession(registry);
    await nextExit(session);

    await expect(openSession(registry)).resolves.toBeDefined();
  });

  it("enforces hard TTL even when activity keeps resetting idle timeout", async () => {
    const { registry } = makeRegistry({
      GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "1",
      GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
      GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "80",
    });
    const session = await openSession(registry);
    const exited = nextExit(session);
    const keepAlive = setInterval(() => void session.resize(80, 24), 20);

    await exited;
    clearInterval(keepAlive);
    await expect(openSession(registry)).resolves.toBeDefined();
  });

  it("replaces malformed helper output with a generic error", async () => {
    const { registry } = makeRegistry();
    const session = await openSession(registry);
    const output = nextOutput(session);

    await session.input("__malformed__");
    expect(await output).toBe("terminal helper failed\r\n");
  });
});
