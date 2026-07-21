import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPtyProvider, type PtyFactory, type PtyLike } from "../../src/core/local-pty-provider.ts";
import { getShellProviderStatus, parseShellProviderPolicy } from "../../src/core/shell-provider-policy.ts";

class MockPty implements PtyLike {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: string[] = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number | null; signal: number | null }) => void> = [];

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(signal?: string): void { this.kills.push(signal ?? "SIGTERM"); }
  onData(listener: (data: string) => void): void { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number | null; signal: number | null }) => void): void { this.exitListeners.push(listener); }

  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(event: { exitCode: number | null; signal: number | null }): void { for (const listener of this.exitListeners) listener(event); }
}

function createProvider(factory?: PtyFactory, overrides: Partial<NodeJS.ProcessEnv> = {}, workspaceRoot = "/repo") {
  const env = {
    NODE_ENV: "development",
    HOST: "localhost",
    GITBOARD_SHELL_PROVIDER_ENABLED: "1",
    GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
    GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
    GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
    GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: workspaceRoot,
    GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/bash,/bin/zsh",
    GITBOARD_SHELL_PROVIDER_MAX_SESSIONS: "2",
    GITBOARD_SHELL_PROVIDER_IDLE_TIMEOUT_MS: "1000",
    GITBOARD_SHELL_PROVIDER_HARD_TTL_MS: "5000",
    GITBOARD_SHELL_PROVIDER_MAX_INPUT_BPS: "8",
    GITBOARD_SHELL_PROVIDER_MAX_OUTPUT_BPS: "8",
    GITBOARD_SHELL_PROVIDER_ENV_SCRUB: "SECRET_TOKEN,PATH",
    HOME: "/home/tester",
    PATH: "/usr/local/bin:/usr/bin",
    TERM: "xterm-256color",
    SECRET_TOKEN: "shh",
    ...overrides,
  } as NodeJS.ProcessEnv;
  const policy = parseShellProviderPolicy(env);
  const status = getShellProviderStatus(env, { isVerifiedAdmin: true });
  return new LocalPtyProvider({ policy, status, workspaceRoot, ptyFactory: factory });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalPtyProvider", () => {
  it("creates session, writes, resizes, and emits output", () => {
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    const output: Array<{ sessionId: string; data: string }> = [];
    provider.on("output", (event) => output.push(event));

    const session = provider.createSession({ cwd: ".", shell: "/bin/bash" });
    expect(session.cwd).toBe(root);
    expect(session.shell).toBe("/bin/bash");

    session.write("echo hi\n");
    session.resize(120, 40);
    pty.emitData("hi\n");

    expect(pty.writes).toEqual(["echo hi\n"]);
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(output).toEqual([{ sessionId: session.id, data: "hi\n" }]);
  });

  it("builds scrubbed spawn env and keeps non-sensitive vars", () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: (options) => { capturedEnv = options.env; return new MockPty(); } }, {
      SECRET_TOKEN: "top-secret",
      PATH: "/usr/bin",
      HOME: "/home/tester",
      USER: "tester",
      LOGNAME: "tester",
    }, root);

    provider.createSession({ cwd: "allowed", shell: "/bin/bash" });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.SECRET_TOKEN).toBeUndefined();
    expect(capturedEnv?.PATH).toBeUndefined();
    expect(capturedEnv?.HOME).toBeUndefined();
    expect(capturedEnv?.TERM).toBeDefined();
    expect(capturedEnv?.LANG).toBe(process.env.LANG);
    expect(capturedEnv?.USER).toBeDefined();
    expect(capturedEnv?.PWD).toBe(root);
  });

  it("rejects cwd outside allowlist, non-existent cwd, and shell outside allowlist", () => {
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => new MockPty() }, {}, root);

    expect(() => provider.createSession({ cwd: "/tmp", shell: "/bin/bash" })).toThrow(/cwd outside allowlist/);
    expect(() => provider.createSession({ cwd: "allowed", shell: "/bin/fish" })).toThrow(/shell outside allowlist/);
  });

  it("rejects symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    const allowed = join(root, "allowed");
    const outside = mkdtempSync(join(tmpdir(), "pty-outside-"));
    mkdirSync(allowed, { recursive: true });
    const escapeLink = join(allowed, "escape");
    symlinkSync(outside, escapeLink);

    const env = {
      NODE_ENV: "development",
      HOST: "localhost",
      GITBOARD_SHELL_PROVIDER_ENABLED: "1",
      GITBOARD_SHELL_PROVIDER_ALLOW_REMOTE: "1",
      GITBOARD_SHELL_PROVIDER_DEV_GATE: "0",
      GITBOARD_SHELL_PROVIDER_ADMIN_ONLY: "0",
      GITBOARD_SHELL_PROVIDER_CWD_ALLOWLIST: root,
      GITBOARD_SHELL_PROVIDER_SHELL_ALLOWLIST: "/bin/bash",
    } as NodeJS.ProcessEnv;
    const provider = new LocalPtyProvider({
      policy: parseShellProviderPolicy(env),
      status: getShellProviderStatus(env, { isVerifiedAdmin: true }),
      workspaceRoot: root,
      ptyFactory: { create: () => new MockPty() },
    });

    expect(() => provider.createSession({ cwd: "allowed/escape", shell: "/bin/bash" })).toThrow(/cwd outside allowlist|cwd missing/);
  });

  it("enforces session cap", () => {
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => new MockPty() }, {}, root);
    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    expect(() => provider.createSession({ cwd: ".", shell: "/bin/bash" })).toThrow(/session cap/);
  });

  it("disposes on idle timeout", () => {
    vi.useFakeTimers();
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    const exits: unknown[] = [];
    provider.on("session:exit", (event) => exits.push(event));

    provider.createSession({ cwd: ".", shell: "/bin/bash" });
    vi.advanceTimersByTime(1000);

    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(exits).toEqual([{ sessionId: "pty-1", exitCode: null, signal: null, reason: "idle-timeout" }]);
    expect(provider.getSessionCount()).toBe(0);
  });

  it("rejects input bursts", () => {
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    const session = provider.createSession({ cwd: ".", shell: "/bin/bash" });

    expect(() => session.write("12345678")).not.toThrow();
    expect(() => session.write("9")).toThrow(/input rate limit exceeded/);
    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(provider.getSessionCount()).toBe(0);
  });

  it("terminates on output bursts", () => {
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    const exits: unknown[] = [];
    provider.on("session:exit", (event) => exits.push(event));
    provider.createSession({ cwd: ".", shell: "/bin/bash" });

    pty.emitData("12345678");
    pty.emitData("9");

    expect(exits).toEqual([{ sessionId: "pty-1", exitCode: null, signal: null, reason: "disposed" }]);
    expect(pty.kills).toEqual(["SIGTERM"]);
  });

  it("disposes explicitly and stops future writes", () => {
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    const session = provider.createSession({ cwd: ".", shell: "/bin/bash" });

    session.dispose();
    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(provider.getSessionCount()).toBe(0);
    expect(() => provider.write(session.id, "x")).toThrow(/unknown session/);
  });

  it("disposes on provider shutdown", () => {
    const pty = new MockPty();
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = createProvider({ create: () => pty }, {}, root);
    provider.createSession({ cwd: ".", shell: "/bin/bash" });

    provider.dispose();
    expect(pty.kills).toEqual(["SIGTERM"]);
    expect(provider.getSessionCount()).toBe(0);
  });

  it("rejects when provider disabled", () => {
    const env = {
      NODE_ENV: "development",
      HOST: "localhost",
      GITBOARD_SHELL_PROVIDER_ENABLED: "0",
    } as NodeJS.ProcessEnv;
    const root = mkdtempSync(join(tmpdir(), "pty-root-"));
    mkdirSync(join(root, "allowed"), { recursive: true });
    const provider = new LocalPtyProvider({
      policy: parseShellProviderPolicy(env),
      status: getShellProviderStatus(env),
      workspaceRoot: root,
      ptyFactory: { create: () => new MockPty() },
    });

    expect(() => provider.createSession({ cwd: ".", shell: "/bin/bash" })).toThrow(/shell provider disabled/);
  });
});
